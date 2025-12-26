// useChunkUpload.js - Chunked Upload Hook
// This hook provides all chunked upload functionality in a reusable composable format

const useChunkUpload = (dependencies = {}) => {
    // Extract dependencies (will be passed from index.html)
    const {
        toastInstance = null,
        chainStoreInstance = null,
        userStoreInstance = null,
        BufferInstance = null,
        MetaIDJsInstance = null
    } = dependencies;

    // Helper to get stores (fallback to global if available)
    const getToast = () => toastInstance || (typeof useToast === 'function' ? useToast() : null);
    const getChainStore = () => chainStoreInstance || (typeof useChainStore === 'function' ? useChainStore() : null);
    const getUserStore = () => userStoreInstance || (typeof useUserStore === 'function' ? useUserStore() : null);
    const getBuffer = () => BufferInstance || (typeof window !== 'undefined' && window.Buffer) || null;
    const getMetaIDJs = () => MetaIDJsInstance || (typeof MetaIDJs !== 'undefined' ? MetaIDJs : null);

    // Helper to get TxComposer and mvc from MetaIDJs
    const getTxComposer = () => {
        const metaidjs = getMetaIDJs();
        return metaidjs ? metaidjs.TxComposer : null;
    };
    const getMvc = () => {
        const metaidjs = getMetaIDJs();
        return metaidjs ? metaidjs.mvc : null;
    };

    // Constants
    const API_BASE = 'https://file.metaid.io/metafile-uploader';
    const TASK_PAGE_SIZE = 10;
    const MULTIPART_CHUNK_SIZE = 1 * 1024 * 1024; // 5MB chunks

    // State variables
    let chunkedUploadChunkNumber = 0;
    let taskList = [];
    let taskCursor = 0;
    let taskHasMore = false;

    // Get DOM elements (with safe fallback)
    const getTaskElements = () => {
        return {
            chunkTaskSection: document.getElementById('chunkTaskSection'),
            taskListContainer: document.getElementById('taskListContainer'),
            loadMoreTasksBtn: document.getElementById('loadMoreTasksBtn'),
            taskListEmpty: document.getElementById('taskListEmpty')
        };
    };

    // Get OSS upload progress DOM elements from HTML
    const getOSSUploadElements = () => {
        // Try to get elements for normal upload first
        let container = document.getElementById('ossUploadProgressDetails');
        let parts = document.getElementById('ossUploadParts');
        let size = document.getElementById('ossUploadSize');
        let speed = document.getElementById('ossUploadSpeed');
        let status = document.getElementById('ossUploadStatus');

        // If not found, try album upload elements
        if (!container) {
            container = document.getElementById('albumOssUploadProgressDetails');
            parts = document.getElementById('albumOssUploadParts');
            size = document.getElementById('albumOssUploadSize');
            speed = document.getElementById('albumOssUploadSpeed');
            status = document.getElementById('albumOssUploadStatus');
        }

        return {
            ossUploadProgress: container,
            ossUploadParts: parts,
            ossUploadSize: size,
            ossUploadSpeed: speed,
            ossUploadStatus: status
        };
    };

    // Update OSS upload progress
    let ossUploadStartTime = null;

    function updateOSSUploadProgress(currentPart, totalParts, uploadedBytes, totalBytes) {
        const {
            ossUploadProgress,
            ossUploadParts,
            ossUploadSize,
            ossUploadSpeed,
            ossUploadStatus
        } = getOSSUploadElements();

        // If progress element doesn't exist or is hidden, skip
        if (!ossUploadProgress || ossUploadProgress.classList.contains('hidden')) {
            return;
        }

        // Update parts
        if (ossUploadParts) {
            ossUploadParts.textContent = `${currentPart} / ${totalParts}`;
        }

        // Update size
        if (ossUploadSize) {
            ossUploadSize.textContent = `${formatFileSize(uploadedBytes)} / ${formatFileSize(totalBytes)}`;
        }

        // Calculate and update speed
        if (ossUploadSpeed && ossUploadStartTime) {
            const now = Date.now();
            const elapsed = (now - ossUploadStartTime) / 1000; // seconds
            if (elapsed > 0) {
                const speed = uploadedBytes / elapsed; // bytes per second
                const speedFormatted = formatFileSize(speed) + '/s';
                ossUploadSpeed.textContent = speedFormatted;
            }
        }

        // Update status
        if (ossUploadStatus) {
            if (currentPart === totalParts && uploadedBytes >= totalBytes) {
                ossUploadStatus.textContent = '完成中...';
            } else if (currentPart > 0) {
                ossUploadStatus.textContent = `上传分片 ${currentPart}/${totalParts}...`;
            } else {
                ossUploadStatus.textContent = '初始化中...';
            }
        }
    }

    // Show OSS upload progress
    function showOSSUploadProgress() {
        const { ossUploadProgress } = getOSSUploadElements();
        if (ossUploadProgress) {
            ossUploadProgress.classList.remove('hidden');
        }
        ossUploadStartTime = Date.now();
    }

    // Hide OSS upload progress
    function hideOSSUploadProgress() {
        const { ossUploadProgress } = getOSSUploadElements();
        if (ossUploadProgress) {
            ossUploadProgress.classList.add('hidden');
        }
        ossUploadStartTime = null;
    }

    // Main function: Run chunked upload flow
    async function runChunkedUploadFlow({ file, asynchronous = true } = {}) {
        
        const toastObj = getToast();
        const chainStore = getChainStore();
        const userStore = getUserStore();

        if (!toastObj || !chainStore || !userStore) {
            throw new Error('Required dependencies (toast, chainStore, userStore) are not available');
        }
        
        const { showToast } = toastObj;
        const flowLabel = 'Async Chunked Upload Task';
        const currentAddress = userStore.last.address;
        try {
            showToast(`Starting ${flowLabel}...`, 'info');

            // Step 1: Upload file to OSS using multipart upload
            const storageKey = await uploadFileToOSS(file);
            
            const estimateResult = await estimateChunkedUploadFee(file, null, storageKey);
            chunkedUploadChunkNumber = estimateResult.chunkNumber; // Store for progress calculation

            const confirmed = await showChunkedUploadConfirmation(file, estimateResult);
            if (!confirmed) {
                return;
            }

            // Calculate fees for building PreTx transactions
            const preTxBaseSize = 200; // Base transaction overhead
            const preTxInputSize = 150; // Per input with signature
            const preTxOutputSize = 34; // Per output
            const feeRate = chainStore.mvcFeeRate() || 1;

            // Estimate chunk PreTx size (1 input, no outputs yet - backend will add)
            const chunkPreTxSize = preTxBaseSize + preTxInputSize;
            const chunkPreTxBuildFee = Math.ceil(chunkPreTxSize * feeRate);

            // Estimate index PreTx size (1 input, no outputs yet - backend will add)
            const indexPreTxSize = preTxBaseSize + preTxInputSize;
            const indexPreTxBuildFee = Math.ceil(indexPreTxSize * feeRate);

            // Calculate total required amount for merge transaction
            const chunkPreTxOutputAmount = estimateResult.chunkPreTxFee + chunkPreTxBuildFee;
            const indexPreTxOutputAmount = estimateResult.indexPreTxFee + indexPreTxBuildFee;

            // Estimate merge transaction fee
            const mergeTxBaseSize = 200;
            const mergeTxInputSize = 150;
            const mergeTxOutputSize = 34;
            const estimatedMergeTxInputs = 2; // Assume 2 inputs
            const mergeTxSize = mergeTxBaseSize + (mergeTxInputSize * estimatedMergeTxInputs) + (mergeTxOutputSize * 2); // 2 outputs
            const mergeTxFee = Math.ceil(mergeTxSize * feeRate);

            const totalRequiredAmount = chunkPreTxOutputAmount + indexPreTxOutputAmount + mergeTxFee;

            const allUtxos = await getWalletUTXOs(totalRequiredAmount);
            showToast('Please confirm merge transaction in wallet...', 'info');
            const mergeResult = await buildChunkedUploadMergeTx(
                allUtxos,
                chunkPreTxOutputAmount,
                indexPreTxOutputAmount,
                mergeTxFee
            );

            showToast('Please confirm pre-transactions in wallet...', 'info');

            // Build chunk funding pre-tx using merge tx output
            const chunkPreTxUtxo = {
                utxos: [{
                    txId: mergeResult.mergeTxId,
                    outputIndex: mergeResult.chunkPreTxOutputIndex,
                    script: mergeResult.chunkPreTxScript,
                    satoshis: chunkPreTxOutputAmount
                }],
                totalAmount: chunkPreTxOutputAmount
            };
            const chunkPreTxHex = await buildChunkFundingPreTx(chunkPreTxUtxo, estimateResult.chunkPreTxFee);

            // Build index pre-tx using merge tx output
            const indexPreTxUtxo = {
                utxos: [{
                    txId: mergeResult.mergeTxId,
                    outputIndex: mergeResult.indexPreTxOutputIndex,
                    script: mergeResult.indexPreTxScript,
                    satoshis: indexPreTxOutputAmount
                }],
                totalAmount: indexPreTxOutputAmount
            };
            const indexPreTxHex = await buildIndexPreTx(indexPreTxUtxo, estimateResult.indexPreTxFee);

            if (asynchronous) {
                
                await createChunkedUploadTask(file, null, storageKey, chunkPreTxHex, indexPreTxHex, mergeResult.mergeTxHex);
                showToast('🎉 Async chunk upload task created! Monitor progress in task list.', 'success');

                const { chunkTaskSection } = getTaskElements();
                if (chunkTaskSection) {
                    chunkTaskSection.classList.remove('hidden');
                }
                loadChunkTasks({ append: false, silent: true });
            } else {
                
                // Synchronous upload with progress tracking
                const baseProgress = 50;
                const uploadProgressRange = 40; // 50% to 90%
                const totalTransactions = chunkedUploadChunkNumber + 1; // chunks + index transaction
                const estimatedTotalSeconds = totalTransactions * 3; // 3 seconds per transaction
                const progressPerSecond = uploadProgressRange / estimatedTotalSeconds;

                let currentProgress = baseProgress;
                let elapsedSeconds = 0;
                let progressInterval = null;
                let isApiReturned = false;

                // Start progress simulation timer
                progressInterval = setInterval(() => {
                    if (isApiReturned) {
                        clearInterval(progressInterval);
                        return;
                    }

                    elapsedSeconds++;
                    currentProgress = baseProgress + (progressPerSecond * elapsedSeconds);

                    if (currentProgress >= 90) {
                        currentProgress = 90;
                        clearInterval(progressInterval);
                        return;
                    }
                }, 1000);

                let uploadResult;
                try {
                    uploadResult = await chunkedUpload(file, null, storageKey, chunkPreTxHex, indexPreTxHex, mergeResult.mergeTxHex);

                    isApiReturned = true;
                    if (progressInterval) {
                        clearInterval(progressInterval);
                        progressInterval = null;
                    }
                } catch (error) {
                    isApiReturned = true;
                    if (progressInterval) {
                        clearInterval(progressInterval);
                        progressInterval = null;
                    }
                    throw error;
                }

                if (uploadResult.status === 'failed') {
                    const errorMessage = uploadResult.message || 'Upload failed with unknown error';
                    throw new Error(errorMessage);
                }

                showToast(`🎉 File uploaded successfully!`, 'success');
                console.log('📝 Upload complete with pinId:', uploadResult.indexTxId + 'i0');
                return {
                    txId:uploadResult.indexTxId,
                    pinId:`${uploadResult.indexTxId}i0`
                }
            }
        } catch (error) {
            console.error('❌ Chunked upload flow failed:', error);

            if (error.message && error.message.includes('user cancelled')) {
                showToast(`${flowLabel} cancelled`, 'warning');
            } else {
                showToast(`${flowLabel} failed: ` + error.message, 'error');
            }
        }
    }

    // Upload file to OSS using multipart upload with resume support
    async function uploadFileToOSS(file) {
        try {
            const userStore = getUserStore();
            if (!userStore) throw new Error('UserStore not available');
            const metaId = userStore.last.metaid;
            const currentAddress = userStore.last.address;

            // Show upload progress
            showOSSUploadProgress();

            // Check for existing upload session (resume support)
            let existingSession = getUploadSession(file, metaId, currentAddress);
            let uploadId, key;
            let existingParts = [];

            if (existingSession) {
                uploadId = existingSession.uploadId;
                key = existingSession.key;

                // List existing parts
                try {
                    const listPartsResponse = await fetch(`${API_BASE}/api/v1/files/multipart/list-parts`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            uploadId: uploadId,
                            key: key
                        })
                    });
                    
                    if (listPartsResponse.ok) {
                        const listPartsResult = await listPartsResponse.json();
                        if (listPartsResult.code === 0 && listPartsResult.data && listPartsResult.data.parts) {
                            existingParts = listPartsResult.data.parts;
                        }
                    }
                } catch (e) {
                    existingSession = null;
                }
            }

            // If no existing session or resume failed, initiate new upload
            if (!existingSession || existingParts.length === 0) {
                const initiateResponse = await fetch(`${API_BASE}/api/v1/files/multipart/initiate`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        fileName: file.name,
                        fileSize: file.size,
                        metaId: metaId,
                        address: currentAddress
                    })
                });

                if (!initiateResponse.ok) {
                    throw new Error(`Failed to initiate multipart upload: HTTP ${initiateResponse.status}`);
                }

                const initiateResult = await initiateResponse.json();
                if (initiateResult.code !== 0) {
                    throw new Error(initiateResult.message || 'Failed to initiate multipart upload');
                }

                uploadId = initiateResult.data.uploadId;
                key = initiateResult.data.key;
                existingParts = [];

                // Save session to localStorage
                saveUploadSession(file, metaId, currentAddress, uploadId, key);
            }

            // Step 2: Upload parts (skip already uploaded parts)
            const totalParts = Math.ceil(file.size / MULTIPART_CHUNK_SIZE);
            const totalBytes = file.size;

            // Create a map of existing parts by part number
            const existingPartsMap = new Map();
            existingParts.forEach(part => {
                existingPartsMap.set(part.partNumber, part);
            });

            const parts = [];
            let uploadedBytes = 0;

            // Initial progress update
            updateOSSUploadProgress(0, totalParts, uploadedBytes, totalBytes);

            for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
                const start = (partNumber - 1) * MULTIPART_CHUNK_SIZE;
                const end = Math.min(start + MULTIPART_CHUNK_SIZE, file.size);
                const partSize = end - start;

                // Check if this part was already uploaded
                if (existingPartsMap.has(partNumber)) {
                    const existingPart = existingPartsMap.get(partNumber);
                    parts.push({
                        partNumber: partNumber,
                        etag: existingPart.etag,
                        size: partSize
                    });
                    uploadedBytes += partSize;

                    // Update progress for skipped part
                    updateOSSUploadProgress(partNumber, totalParts, uploadedBytes, totalBytes);
                    continue;
                }

                // Upload this part
                const chunk = file.slice(start, end);

                // Read chunk as base64
                const chunkBase64 = await new Promise((resolve, reject) => {
                    const fileReader = new FileReader();
                    fileReader.onload = () => {
                        const base64 = fileReader.result.split(',')[1] || fileReader.result;
                        resolve(base64);
                    };
                    fileReader.onerror = reject;
                    fileReader.readAsDataURL(chunk);
                });

                // Upload part
                const uploadPartResponse = await fetch(`${API_BASE}/api/v1/files/multipart/upload-part`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        uploadId: uploadId,
                        key: key,
                        partNumber: partNumber,
                        content: chunkBase64
                    })
                });

                if (!uploadPartResponse.ok) {
                    throw new Error(`Failed to upload part ${partNumber}: HTTP ${uploadPartResponse.status}`);
                }

                const uploadPartResult = await uploadPartResponse.json();
                if (uploadPartResult.code !== 0) {
                    throw new Error(uploadPartResult.message || `Failed to upload part ${partNumber}`);
                }

                parts.push({
                    partNumber: partNumber,
                    etag: uploadPartResult.data.etag,
                    size: partSize
                });

                uploadedBytes += partSize;

                // Update progress after uploading each part
                updateOSSUploadProgress(partNumber, totalParts, uploadedBytes, totalBytes);
            }

            // Sort parts by part number (required for completion)
            parts.sort((a, b) => a.partNumber - b.partNumber);

            // Step 3: Complete multipart upload
            // Update status to completing
            updateOSSUploadProgress(totalParts, totalParts, totalBytes, totalBytes);

            const completeResponse = await fetch(`${API_BASE}/api/v1/files/multipart/complete`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    uploadId: uploadId,
                    key: key,
                    parts: parts
                })
            });

            if (!completeResponse.ok) {
                throw new Error(`Failed to complete multipart upload: HTTP ${completeResponse.status}`);
            }

            const completeResult = await completeResponse.json();
            if (completeResult.code !== 0) {
                throw new Error(completeResult.message || 'Failed to complete multipart upload');
            }

            const storageKey = completeResult.data.key;

            // Clear upload session from localStorage after successful completion
            clearUploadSession(file, metaId, currentAddress);

            // Hide upload progress on success
            hideOSSUploadProgress();

            return storageKey;
        } catch (error) {
            console.error('❌ Failed to upload file to OSS:', error);

            // Hide upload progress on error
            hideOSSUploadProgress();

            throw new Error(`Failed to upload file to OSS: ${error.message}`);
        }
    }

    // Estimate chunked upload fee
    async function estimateChunkedUploadFee(file, fileContentBase64, storageKey) {
        
        try {
            const chainStore = getChainStore();
            if (!chainStore) throw new Error('ChainStore not available');
            const path = '/file';
            const contentType = buildContentType(file);

            const requestBody = {
                fileName: file.name,
                path: path,
                contentType: contentType,
                feeRate: chainStore.mvcFeeRate() || 1
            };
            
            // Use storageKey if provided, otherwise use content
            if (storageKey) {
                requestBody.storageKey = storageKey;
            } else if (fileContentBase64) {
                requestBody.content = fileContentBase64;
            } else {
                throw new Error('Either storageKey or content must be provided');
            }

            const requestOptions = await prepareJsonRequestBody(requestBody);
            
            const response = await fetch(`${API_BASE}/api/v1/files/estimate-chunked-upload`, {
                method: 'POST',
                headers: requestOptions.headers,
                body: requestOptions.body,
                 mode: 'cors',
            });

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }

            const result = await response.json();

            if (result.code !== 0) {
                throw new Error(result.message);
            }

            return result.data;
        } catch (error) {
            console.error('❌ Failed to estimate chunked upload fee:', error);
            throw new Error(`Failed to estimate fee: ${error.message}`);
        }
    }

    // Show chunked upload confirmation dialog
    function showChunkedUploadConfirmation(file, estimateResult) {
        return new Promise((resolve) => {
            // Create modal dialog
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10001;
            `;

            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: white;
                padding: 30px;
                border-radius: 12px;
                max-width: 600px;
                width: 90%;
                max-height: 80vh;
                overflow-y: auto;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            `;

            dialog.innerHTML = `
                <h2 style="margin-top: 0; color: #333;">📦 Chunked Upload Confirmation</h2>
                <div style="margin: 20px 0;">
                    <div style="margin: 10px 0;">
                        <strong>📊 File Information:</strong>
                        <ul style="margin: 5px 0; padding-left: 20px;">
                            <li>File Name: ${file.name}</li>
                            <li>File Size: ${formatFileSize(file.size)}</li>
                            <li>Chunk Size: ${formatFileSize(estimateResult.chunkSize)}</li>
                            <li>Number of Chunks: ${estimateResult.chunkNumber}</li>
                        </ul>
                    </div>
                    <div style="margin: 10px 0;">
                        <strong>💰 Fee Information:</strong>
                        <ul style="margin: 5px 0; padding-left: 20px;">
                            <li>Chunk Funding Fee: ${formatSatoshis(estimateResult.chunkPreTxFee)}</li>
                            <li>Index Transaction Fee: ${formatSatoshis(estimateResult.indexPreTxFee)}</li>
                            <li>Total Fee: ${formatSatoshis(estimateResult.totalFee)}</li>
                            <li>Per Chunk Fee: ${formatSatoshis(estimateResult.perChunkFee)}</li>
                        </ul>
                    </div>
                    <div style="margin: 10px 0; padding: 10px; background: #fff3cd; border-radius: 6px; border: 1px solid #ffc107;">
                        <strong>⚠️ Important Notice:</strong>
                        <p style="margin: 5px 0; font-size: 14px; color: #856404;">
                            This large file will be split into ${estimateResult.chunkNumber} chunks.
                            You need to confirm ${estimateResult.chunkNumber + 2} transactions:
                            <br>1. Chunk funding transaction (${estimateResult.chunkNumber} outputs)
                            <br>2. ${estimateResult.chunkNumber} chunk transactions
                            <br>3. Index transaction
                            <br><br>
                            <strong>Please do not close the browser or refresh the page during upload!</strong>
                        </p>
                    </div>
                </div>
                <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
                    <button id="cancelChunkedUpload" style="
                        padding: 10px 20px;
                        background: #ccc;
                        color: #333;
                        border: none;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                    ">Cancel</button>
                    <button id="confirmChunkedUpload" style="
                        padding: 10px 20px;
                        background: #28a745;
                        color: white;
                        border: none;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: bold;
                    ">Confirm & Start Upload</button>
                </div>
            `;

            modal.appendChild(dialog);
            document.body.appendChild(modal);

            // Handle button clicks
            document.getElementById('confirmChunkedUpload').addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve(true);
            });

            document.getElementById('cancelChunkedUpload').addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve(false);
            });

            // Close on background click
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    document.body.removeChild(modal);
                    resolve(false);
                }
            });
        });
    }

    // Get wallet UTXOs
    async function getWalletUTXOs(requiredAmount) {
        try {
            const mvc = getMvc();
            if (!mvc) throw new Error('MVC library not available');

            // Get UTXOs from wallet
            const utxos = await window.metaidwallet.getUtxos();

            if (!utxos || utxos.length === 0) {
                throw new Error('No available UTXOs in wallet');
            }

            // Filter UTXOs: only select UTXOs > 600 satoshis
            const filler = 600;
            const fillerUtxos = utxos.filter(utxo => utxo.value > filler);

            if (!fillerUtxos || fillerUtxos.length === 0) {
                throw new Error('No UTXOs larger than 600 satoshis available in wallet');
            }

            // Sort UTXOs by amount (descending)
            const sortedUtxos = fillerUtxos.sort((a, b) => b.value - a.value);

            // Select UTXOs to meet required amount
            let selectedUtxos = [];
            let totalAmount = 0;

            for (const utxo of sortedUtxos) {
                // Convert address to script
                let scriptHex = mvc.Script.buildPublicKeyHashOut(utxo.address).toHex();
                selectedUtxos.push({
                    txId: utxo.txid,
                    outputIndex: utxo.outIndex,
                    script: scriptHex,
                    satoshis: utxo.value
                });
                totalAmount += utxo.value;

                // Add buffer for change output
                if (totalAmount >= requiredAmount + 1) {
                    break;
                }
            }

            if (totalAmount < requiredAmount + 1) {
                throw new Error(`Insufficient balance! Need ${requiredAmount + 1} satoshis, but only have ${totalAmount} satoshis`);
            }

            return {
                utxos: selectedUtxos,
                totalAmount: totalAmount
            };
        } catch (error) {
            console.error('Failed to get UTXOs:', error);
            throw new Error(`Failed to get UTXOs: ${error.message}`);
        }
    }

    // Build merge transaction for chunked upload
    async function buildChunkedUploadMergeTx(utxoData, chunkPreTxOutputAmount, indexPreTxOutputAmount, mergeTxFee) {
        try {
            const userStore = getUserStore();
            const chainStore = getChainStore();
            const mvc = getMvc();
            const TxComposer = getTxComposer();

            if (!userStore || !chainStore) throw new Error('Required stores not available');
            if (!mvc || !TxComposer) throw new Error('MetaIDJs library (mvc/TxComposer) not available');

            // Create merge transaction with two outputs
            const mergeTx = new mvc.Transaction();
            mergeTx.version = 10;

            // Add inputs from UTXOs
            for (const utxo of utxoData.utxos) {
                mergeTx.from({
                    txId: utxo.txId,
                    outputIndex: utxo.outputIndex,
                    script: utxo.script,
                    satoshis: utxo.satoshis
                });
            }

            // Add two outputs: one for chunk PreTx, one for index PreTx
            mergeTx.to(userStore.last.address, chunkPreTxOutputAmount);
            mergeTx.to(userStore.last.address, indexPreTxOutputAmount);

            // Check if pay method is available
            if (typeof window.metaidwallet.pay !== 'function') {
                throw new Error('Wallet does not support pay method');
            }

            // Create TxComposer
            const txComposer = new TxComposer(mergeTx);
            const txComposerSerialize = txComposer.serialize();

            // Build pay params
            const feeRate = chainStore.mvcFeeRate() || 1;
            const payParams = {
                transactions: [
                    {
                        txComposer: txComposerSerialize,
                        message: 'Merge UTXOs for chunked upload',
                    }
                ],
                feeb: feeRate,
            };

            const payResult = await window.metaidwallet.pay(payParams);

            // Deserialize the payed transaction
            const payedTxComposerStr = payResult.payedTransactions[0];
            const payedTxComposer = TxComposer.deserialize(payedTxComposerStr);

            // Get signed transaction hex
            const signedMergeTxHex = payedTxComposer.getRawHex();
            const mergeTxId = payedTxComposer.getTxId();

            // Parse the transaction to get output info
            const parsedMergeTx = new mvc.Transaction(signedMergeTxHex);

            // Find outputs by matching amounts
            let chunkPreTxOutputIndex = -1;
            let indexPreTxOutputIndex = -1;
            let chunkPreTxScript = null;
            let indexPreTxScript = null;

            const amountTolerance = 1000; // 1000 satoshis tolerance

            // Find outputs by amount match
            for (let i = 0; i < parsedMergeTx.outputs.length; i++) {
                const output = parsedMergeTx.outputs[i];
                const outputScript = output.script.toHex();
                const outputAmount = output.satoshis;

                try {
                    const addr = output.script.toAddress(mvc.Networks.livenet);
                    if (addr && addr.toString() === userStore.last.address) {
                        // Match chunk PreTx output by amount
                        if (chunkPreTxOutputIndex === -1 &&
                            Math.abs(outputAmount - chunkPreTxOutputAmount) <= amountTolerance) {
                            chunkPreTxOutputIndex = i;
                            chunkPreTxScript = outputScript;
                        }
                        // Match index PreTx output by amount
                        else if (indexPreTxOutputIndex === -1 &&
                                 Math.abs(outputAmount - indexPreTxOutputAmount) <= amountTolerance) {
                            indexPreTxOutputIndex = i;
                            indexPreTxScript = outputScript;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }

            return {
                mergeTxId: mergeTxId,
                mergeTxHex: signedMergeTxHex,
                chunkPreTxOutputIndex: chunkPreTxOutputIndex,
                indexPreTxOutputIndex: indexPreTxOutputIndex,
                chunkPreTxScript: chunkPreTxScript,
                indexPreTxScript: indexPreTxScript
            };

        } catch (error) {
            console.error('Failed to build merge transaction:', error);
            throw new Error(`Failed to build merge transaction: ${error.message}`);
        }
    }

    // Build chunk funding pre-tx
    async function buildChunkFundingPreTx(utxoData, totalChunkFee) {
        try {
            const userStore = getUserStore();
            const mvc = getMvc();
            const Buffer = getBuffer();

            if (!userStore) throw new Error('UserStore not available');
            if (!mvc || !Buffer) throw new Error('MetaIDJs library (mvc) or Buffer not available');

            const tx = new mvc.Transaction();
            tx.version = 10;

            // Add inputs from UTXOs
            for (const utxo of utxoData.utxos) {
                tx.from({
                    txId: utxo.txId,
                    outputIndex: utxo.outputIndex,
                    script: utxo.script,
                    satoshis: utxo.satoshis
                });
            }

            // Sign each input with signNull
            for (let i = 0; i < utxoData.utxos.length; i++) {
                const utxo = utxoData.utxos[i];
                const signResult = await window.metaidwallet.signTransaction({
                    transaction: {
                        txHex: tx.toString(),
                        address: userStore.last.address,
                        inputIndex: i,
                        scriptHex: utxo.script,
                        satoshis: utxo.satoshis,
                        sigtype: 0x2 | 0x40 // SIGHASH_NONE | SIGHASH_ANYONECANPAY
                    }
                });

                const sig = signResult.signature.sig;
                const publicKey = signResult.signature.publicKey;
                const unlockingScript = mvc.Script.buildPublicKeyHashIn(
                    publicKey,
                    mvc.crypto.Signature.fromTxFormat(Buffer.from(sig, 'hex')).toDER(),
                    0x2 | 0x40
                );
                tx.inputs[i].setScript(unlockingScript);
            }

            const signedTxHex = tx.toString();
            return signedTxHex;

        } catch (error) {
            console.error('Failed to build chunk funding pre-tx:', error);
            throw new Error(`Failed to build chunk funding pre-tx: ${error.message}`);
        }
    }

    // Build index pre-tx
    async function buildIndexPreTx(utxoData, indexFee) {
        try {
            const userStore = getUserStore();
            const mvc = getMvc();
            const Buffer = getBuffer();

            if (!userStore) throw new Error('UserStore not available');
            if (!mvc || !Buffer) throw new Error('MetaIDJs library (mvc) or Buffer not available');

            const tx = new mvc.Transaction();
            tx.version = 10;

            // Add inputs from UTXOs
            for (const utxo of utxoData.utxos) {
                tx.from({
                    txId: utxo.txId,
                    outputIndex: utxo.outputIndex,
                    script: utxo.script,
                    satoshis: utxo.satoshis
                });
            }

            // Sign each input with signNull
            for (let i = 0; i < utxoData.utxos.length; i++) {
                const utxo = utxoData.utxos[i];
                const signResult = await window.metaidwallet.signTransaction({
                    transaction: {
                        txHex: tx.toString(),
                        address: userStore.last.address,
                        inputIndex: i,
                        scriptHex: utxo.script,
                        satoshis: utxo.satoshis,
                        sigtype: 0x2 | 0x40 // SIGHASH_NONE | SIGHASH_ANYONECANPAY
                    }
                });

                const sig = signResult.signature.sig;
                const publicKey = signResult.signature.publicKey;
                const unlockingScript = mvc.Script.buildPublicKeyHashIn(
                    publicKey,
                    mvc.crypto.Signature.fromTxFormat(Buffer.from(sig, 'hex')).toDER(),
                    0x2 | 0x40
                );
                tx.inputs[i].setScript(unlockingScript);
            }

            const signedTxHex = tx.toString();
            return signedTxHex;

        } catch (error) {
            console.error('Failed to build index pre-tx:', error);
            throw new Error(`Failed to build index pre-tx: ${error.message}`);
        }
    }

    // Create async chunked upload task
    async function createChunkedUploadTask(file, fileContentBase64, storageKey, chunkPreTxHex, indexPreTxHex, mergeTxHex) {
        try {
            const userStore = getUserStore();
            const chainStore = getChainStore();
            if (!userStore || !chainStore) throw new Error('Required stores not available');
            const path = '/file';
            const contentType = buildContentType(file);
            const metaId = userStore.last.metaid;
            const currentAddress = userStore.last.address;

            const requestBody = {
                metaId: metaId,
                address: currentAddress,
                fileName: file.name,
                path: path,
                operation: 'create',
                contentType: contentType,
                chunkPreTxHex: chunkPreTxHex,
                indexPreTxHex: indexPreTxHex,
                mergeTxHex: mergeTxHex,
                feeRate: chainStore.mvcFeeRate() || 1
            };

            // Use storageKey if provided, otherwise use content
            if (storageKey) {
                requestBody.storageKey = storageKey;
            } else if (fileContentBase64) {
                requestBody.content = fileContentBase64;
            } else {
                throw new Error('Either storageKey or content must be provided');
            }

            const requestOptions = await prepareJsonRequestBody(requestBody);
            const response = await fetch(`${API_BASE}/api/v1/files/chunked-upload-task`, {
                method: 'POST',
                headers: requestOptions.headers,
                body: requestOptions.body
            });

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }

            const result = await response.json();
            if (result.code !== 0) {
                throw new Error(result.message);
            }

            return result.data;
        } catch (error) {
            console.error('❌ Failed to create chunked upload task:', error);
            throw new Error(`Chunked upload task failed: ${error.message}`);
        }
    }

    // Load chunk tasks
    async function loadChunkTasks(options = {}) {
        const { append = false, silent = false } = options;
        const userStore = getUserStore();
        const toastObj = getToast();
        if (!userStore || !toastObj) {
            console.error('Required stores not available for loadChunkTasks');
            return;
        }
        const { showToast } = toastObj;
        const { taskListContainer, loadMoreTasksBtn } = getTaskElements();

        if (!taskListContainer) return;

        if (append && !taskHasMore) {
            showToast('No more tasks', 'info');
            return;
        }

        try {
            const cursorParam = append ? taskCursor : 0;
            const url = new URL(`${API_BASE}/api/v1/files/tasks`);
            url.searchParams.set('address', userStore.last.address);
            url.searchParams.set('cursor', cursorParam);
            url.searchParams.set('size', TASK_PAGE_SIZE);

            const response = await fetch(url.toString());
            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }

            const result = await response.json();
            if (result.code !== 0) {
                throw new Error(result.message || 'Failed to fetch tasks');
            }

            const data = result.data || { tasks: [], nextCursor: 0, hasMore: false };
            const tasks = data.tasks || [];

            if (!append) {
                taskList = tasks;
            } else {
                taskList = taskList.concat(tasks);
            }

            renderTaskList(taskList);
            taskCursor = data.nextCursor || 0;
            taskHasMore = !!data.hasMore;

            if (loadMoreTasksBtn) {
                loadMoreTasksBtn.disabled = !taskHasMore;
            }
        } catch (error) {
            console.error('❌ Failed to load tasks:', error);
            if (!silent) {
                showToast('Failed to load tasks: ' + error.message, 'error');
            }
        }
    }

    // Chunked upload (synchronous)
    async function chunkedUpload(file, fileContentBase64, storageKey, chunkPreTxHex, indexPreTxHex, mergeTxHex) {
        try {
            const userStore = getUserStore();
            const chainStore = getChainStore();
            if (!userStore || !chainStore) throw new Error('Required stores not available');
            const path = '/file';
            const contentType = buildContentType(file);
            const metaId = userStore.last.metaid;
            const currentAddress = userStore.last.address;

            const requestBody = {
                metaId: metaId,
                address: currentAddress,
                fileName: file.name,
                path: path,
                operation: 'create',
                contentType: contentType,
                chunkPreTxHex: chunkPreTxHex,
                indexPreTxHex: indexPreTxHex,
                mergeTxHex: mergeTxHex,
                feeRate: chainStore.mvcFeeRate() || 1,
                isBroadcast: true
            };

            // Use storageKey if provided, otherwise use content
            if (storageKey) {
                requestBody.storageKey = storageKey;
            } else if (fileContentBase64) {
                requestBody.content = fileContentBase64;
            } else {
                throw new Error('Either storageKey or content must be provided');
            }

            const requestOptions = await prepareJsonRequestBody(requestBody);

            const response = await fetch(`${API_BASE}/api/v1/files/chunked-upload`, {
                method: 'POST',
                headers: requestOptions.headers,
                body: requestOptions.body
            });

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }

            const result = await response.json();

            if (result.code !== 0) {
                throw new Error(result.message);
            }
            console.log(" result.data", result.data)
            debugger
            return result.data;
        } catch (error) {
            console.error('❌ ChunkedUpload failed:', error);
            throw new Error(`ChunkedUpload failed: ${error.message}`);
        }
    }

    // Helper functions
    function getUploadSession(file, metaId, address) {
        const sessionKey = getUploadSessionKey(file, metaId, address);
        const sessionData = localStorage.getItem(sessionKey);
        if (!sessionData) return null;

        try {
            const session = JSON.parse(sessionData);
            // Check if session is still valid (within 7 days)
            const maxAge = 7 * 24 * 60 * 60 * 1000;
            if (Date.now() - session.timestamp > maxAge) {
                localStorage.removeItem(sessionKey);
                return null;
            }
            return session;
        } catch (e) {
            localStorage.removeItem(sessionKey);
            return null;
        }
    }

    function getUploadSessionKey(file, metaId, address) {
        return `multipart_upload_${file.name}_${file.size}_${metaId}_${address}`;
    }

    function saveUploadSession(file, metaId, address, uploadId, key) {
        const sessionKey = getUploadSessionKey(file, metaId, address);
        const sessionData = {
            uploadId: uploadId,
            key: key,
            fileName: file.name,
            fileSize: file.size,
            metaId: metaId,
            address: address,
            timestamp: Date.now()
        };
        localStorage.setItem(sessionKey, JSON.stringify(sessionData));
    }

    function clearUploadSession(file, metaId, address) {
        const sessionKey = getUploadSessionKey(file, metaId, address);
        localStorage.removeItem(sessionKey);
    }

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    function formatSatoshis(satoshis) {
        const space = satoshis / 100000000;
        return `${space.toFixed(8)} SPACE (${satoshis.toLocaleString()} sats)`;
    }

    function buildContentType(file) {
        let contentType = file.type || 'application/octet-stream';

        // Check if it's a text type
        const isTextType = contentType.startsWith('text/') ||
                          contentType === 'application/json' ||
                          contentType === 'application/javascript' ||
                          contentType === 'application/xml';

        // Only add ;binary for non-text types
        if (!isTextType && !contentType.includes(';binary')) {
            contentType = contentType + ';binary';
        }

        return contentType;
    }

    async function prepareJsonRequestBody(data) {
        try {
            const jsonString = JSON.stringify(data);
            // 
            // if (typeof CompressionStream === 'function') {
            //     try {
            //         const compressedBody = await gzipCompressString(jsonString);
            //         return {
            //             body: compressedBody,
            //             headers: {
            //                 'Content-Type': 'application/json',
            //                 'Content-Encoding': 'gzip'
            //             }
            //         };
            //     } catch (error) {
            //         console.warn('[prepareJsonRequestBody] Failed to gzip, fallback to plain JSON:', error);
            //     }
            // }

            return {
                body: jsonString,
                headers: {
                    'Content-Type': 'application/json'
                }
            };
        } catch (error) {
            console.error('[prepareJsonRequestBody] Error:', error);
            throw error;
        }
    }

    async function gzipCompressString(str) {
        try {
            const blob = new Blob([str], { type: 'application/json' });
            const compressionStream = new CompressionStream('gzip');
            const compressedStream = blob.stream().pipeThrough(compressionStream);

            const reader = compressedStream.getReader();
            const chunks = [];
            let totalLength = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                totalLength += value.length;
            }

            const arrayBuffer = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                arrayBuffer.set(chunk, offset);
                offset += chunk.length;
            }

            return arrayBuffer.buffer;
        } catch (error) {
            console.error('[gzipCompressString] Error:', error);
            throw error;
        }
    }

    function renderTaskList(tasks) {
        const { taskListContainer, taskListEmpty } = getTaskElements();
        if (!taskListContainer) return;

        if (!tasks || tasks.length === 0) {
            taskListContainer.innerHTML = '';
            if (taskListEmpty) {
                taskListEmpty.classList.remove('hidden');
            }
            return;
        }

        if (taskListEmpty) {
            taskListEmpty.classList.add('hidden');
        }

        taskListContainer.innerHTML = '';
        tasks.forEach(task => {
            const card = document.createElement('div');
            card.className = 'task-card';
            const statusClass = getStatusClass(task.status);
            const progress = Math.min(Math.max(task.progress || 0, 0), 100);
            const processedInfo = `${task.processedChunks || 0}/${task.totalChunks || 0}`;

            let indexTxIdHtml = '-';
            if (task.indexTxId && task.indexTxId.trim()) {
                const txUrl = `https://www.mvcscan.com/tx/${task.indexTxId}`;
                indexTxIdHtml = `
                    <a href="${txUrl}" target="_blank"
                       style="color: #667eea; text-decoration: none; font-family: monospace; font-size: 12px; word-break: break-all;"
                       onmouseover="this.style.textDecoration='underline'"
                       onmouseout="this.style.textDecoration='none'">
                        ${task.indexTxId}
                    </a>
                `;
            }

            card.innerHTML = `
                <div class="task-card-header">
                    <div>
                        <div style="font-weight: 600; color: #333;">Task ${task.taskId}</div>
                        <div style="font-size: 12px; color: #777;">Created ${new Date(task.createdAt).toLocaleString()}</div>
                    </div>
                    <div class="task-status ${statusClass}">
                        <span>${task.status}</span>
                        <span>${progress}%</span>
                    </div>
                </div>
                <div class="task-progress-bar">
                    <div class="task-progress-fill" style="width: ${progress}%;"></div>
                </div>
                <div class="task-meta">
                    <div><strong>File:</strong> ${task.fileName || 'N/A'}</div>
                    <div><strong>Chunks:</strong> ${processedInfo}</div>
                    <div><strong>Step:</strong> ${task.currentStep || 'Pending'}</div>
                    <div><strong>IndexTxId:</strong> ${indexTxIdHtml}</div>
                    <div><strong>Message:</strong> ${task.errorMessage || task.status || '-'}</div>
                </div>
            `;

            taskListContainer.appendChild(card);
        });
    }

    function getStatusClass(status = '') {
        const normalized = (status || '').toLowerCase();
        if (normalized === 'success') return 'success';
        if (normalized === 'failed') return 'failed';
        if (normalized === 'processing') return 'processing';
        return 'pending';
    }

    // Return public API
    return {
        runChunkedUploadFlow,
        uploadFileToOSS,
        estimateChunkedUploadFee,
        loadChunkTasks,
        renderTaskList
    };
};
