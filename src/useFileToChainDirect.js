// useFileToChainDirect.js - Direct File Upload Hook
// This hook provides direct file upload functionality in a reusable composable format

const useFileToChainDirect = (dependencies = {}) => {
    // Extract dependencies (will be passed from index.html)
    const {
        toastInstance = null,
        chainStoreInstance = null,
        userStoreInstance = null,
        BufferInstance = null,
        MetaIDJsInstance = null,
        constantsInstance = null
    } = dependencies;

    // Helper to get stores (fallback to global if available)
    const getToast = () => toastInstance || (typeof useToast === 'function' ? useToast() : null);
    const getChainStore = () => chainStoreInstance || (typeof useChainStore === 'function' ? useChainStore() : null);
    const getUserStore = () => userStoreInstance || (typeof useUserStore === 'function' ? useUserStore() : null);
    const getBuffer = () => BufferInstance || (typeof window !== 'undefined' && window.Buffer) || null;
    const getMetaIDJs = () => MetaIDJsInstance || (typeof MetaIDJs !== 'undefined' ? MetaIDJs : null);
    const getConstants = () => constantsInstance || (typeof CONSTANTS !== 'undefined' ? CONSTANTS : null);

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

    // Main function: Upload file to chain directly
    async function uploadFileToChainDirect(file) {
        try {
            const toastObj = getToast();
            const chainStore = getChainStore();
            const userStore = getUserStore();

            if (!toastObj || !chainStore || !userStore) {
                throw new Error('Required dependencies (toast, chainStore, userStore) are not available');
            }

            const { showToast } = toastObj;

            // 2. Build ContentType
            let contentType = file.type || 'application/octet-stream';
            if (!contentType.includes(';binary')) {
                contentType = contentType + ';binary';
            }

            // 3. Estimate upload fee
            const estimatedFee = await estimateUploadFee(file);

            console.log('💰 Estimated fee:', estimatedFee, 'satoshis');

            // 4. Get UTXOs
            const utxos = await getWalletUTXOs(estimatedFee);

            console.log('✅ Got', utxos.utxos.length, 'UTXO(s), total:', utxos.totalAmount, 'satoshis');

            // 5. Merge UTXOs if needed
            let finalUtxo = null;
            let mergeTxHex = '';

            if (utxos.utxos.length > 1) {
                console.log('⚠️ Multiple UTXOs detected, merging...');
                const mergeResult = await mergeUTXOs(utxos, estimatedFee);

                finalUtxo = {
                    utxos: mergeResult.utxos,
                    totalAmount: mergeResult.totalAmount
                };
                mergeTxHex = mergeResult.mergeTxHex || '';
                console.log('✅ UTXOs merged successfully');
            } else {
                finalUtxo = {
                    utxos: utxos.utxos,
                    totalAmount: utxos.totalAmount
                };
                console.log('✅ Single UTXO, no merge needed');
            }

            // 6. Build and sign base transaction
            console.log('Please confirm signature in wallet...');
            showToast('Please confirm signature in wallet...', 'info');

            const preTxHex = await buildAndSignBaseTx(finalUtxo);

            console.log('✅ Base transaction signed');

            // 7. Direct upload (one-step: add OP_RETURN + calculate change + broadcast)
            const uploadResult = await directUpload(file, preTxHex, finalUtxo.totalAmount, mergeTxHex);

            console.log('✅ File uploaded successfully!');
            console.log('TxID:', uploadResult.txId);
            console.log('PinID:', uploadResult.pinId);

            return uploadResult;

        } catch (error) {
            console.error('❌ Direct upload failed:', error.message);
            throw error;
        }
    }

    // Estimate upload fee
    async function estimateUploadFee(file) {
        try {
            const chainStore = getChainStore();
            if (!chainStore) throw new Error('ChainStore not available');

            // Base transaction size estimation
            const baseSize = 200; // Basic transaction overhead
            const inputSize = 150; // Per input size (with signature)
            const outputSize = 34; // Per output size
            const opReturnOverhead = 50; // OP_RETURN script overhead

            // File size
            const fileSize = file.size;

            // Calculate OP_RETURN output size
            // MetaID protocol: metaid + operation + path + encryption + version + contentType + content
            const path = '/file';
            const fileHost = '';
            const finalPath = fileHost ? fileHost + ':' + path : path;

            const metadataSize = 6 + 10 + finalPath.length + 10 + 10 + 50; // Rough estimate
            const opReturnSize = opReturnOverhead + metadataSize + fileSize;

            // Total transaction size estimation (1 input, 2 outputs: change + OP_RETURN)
            const estimatedTxSize = baseSize + inputSize + outputSize * 2 + opReturnSize;

            // Get fee rate
            const feeRate = chainStore.mvcFeeRate() || 1;

            // Calculate fee
            const estimatedFee = Math.ceil(estimatedTxSize * feeRate);

            // Add safety margin (20%)
            const feeWithMargin = Math.ceil(estimatedFee * 1.2);

            console.log('Estimated tx size:', estimatedTxSize, 'bytes');
            console.log('Fee rate:', feeRate, 'sat/byte');
            console.log('Estimated fee (with 20% margin):', feeWithMargin, 'satoshis');

            return feeWithMargin;
        } catch (error) {
            console.error('Failed to estimate upload fee:', error);
            throw new Error(`Failed to estimate upload fee: ${error.message}`);
        }
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

            // Filter UTXOs: only select UTXOs > 600 satoshis (to ensure change output is possible)
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

                // Add buffer for change output (1 satoshi for receiver)
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

    // Merge UTXOs
    async function mergeUTXOs(utxoData, estimatedFee) {
        try {
            const userStore = getUserStore();
            const chainStore = getChainStore();
            const mvc = getMvc();
            const TxComposer = getTxComposer();

            if (!userStore || !chainStore) throw new Error('Required stores not available');
            if (!mvc || !TxComposer) throw new Error('MetaIDJs library (mvc/TxComposer) not available');

            // Check if pay method is available
            if (typeof window.metaidwallet.pay !== 'function') {
                throw new Error('Wallet does not support pay method');
            }

            // Create merge transaction - we only specify the output
            // pay method will automatically select inputs, add change, and sign
            const mergeTx = new mvc.Transaction();
            mergeTx.version = 10;

            // Add single output to ourselves (this will merge all UTXOs into one)
            mergeTx.to(userStore.last.address, estimatedFee);

            // Create TxComposer for pay method
            const txComposer = new TxComposer(mergeTx);
            const txComposerSerialize = txComposer.serialize();

            // Build pay params
            const feeRate = chainStore.mvcFeeRate() || 1;
            const payParams = {
                transactions: [
                    {
                        txComposer: txComposerSerialize,
                        message: 'Merge UTXOs',
                    }
                ],
                feeb: feeRate,
            };

            // Call pay method - it will auto select inputs, add change, and sign
            const payResult = await window.metaidwallet.pay(payParams);

            // Deserialize the payed transaction
            const payedTxComposerStr = payResult.payedTransactions[0];
            const payedTxComposer = TxComposer.deserialize(payedTxComposerStr);

            // Get signed transaction hex
            const signedMergeTxHex = payedTxComposer.getRawHex();
            const mergeTxId = payedTxComposer.getTxId();

            // Parse the transaction to get output info
            const parsedMergeTx = new mvc.Transaction(signedMergeTxHex);

            // Find the output that goes to our address (the merged UTXO)
            let mergedOutputIndex = -1;
            let mergedOutputAmount = 0;

            for (let i = 0; i < parsedMergeTx.outputs.length; i++) {
                const output = parsedMergeTx.outputs[i];
                try {
                    const addr = output.script.toAddress(mvc.Networks.livenet);
                    if (addr && addr.toString() === userStore.last.address) {
                        mergedOutputIndex = i;
                        mergedOutputAmount = output.satoshis;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            if (mergedOutputIndex === -1) {
                // Fallback: use the first output
                mergedOutputIndex = 0;
                mergedOutputAmount = parsedMergeTx.outputs[0].satoshis;
            }

            // Create new UTXO info from merge transaction
            const newUtxo = {
                txId: mergeTxId,
                outputIndex: mergedOutputIndex,
                script: parsedMergeTx.outputs[mergedOutputIndex].script.toHex(),
                satoshis: mergedOutputAmount
            };

            return {
                utxos: [newUtxo],
                totalAmount: newUtxo.satoshis,
                mergeTxId: mergeTxId,
                mergeTxHex: signedMergeTxHex
            };

        } catch (error) {
            console.error('Failed to merge UTXOs:', error);
            throw new Error(`Failed to merge UTXOs: ${error.message}`);
        }
    }

    // Build and sign base transaction
    async function buildAndSignBaseTx(utxoData) {
        try {
            const userStore = getUserStore();
            const mvc = getMvc();
            const Buffer = getBuffer();

            if (!userStore) throw new Error('UserStore not available');
            if (!mvc || !Buffer) throw new Error('MetaIDJs library (mvc) or Buffer not available');

            // Validate: must have exactly one UTXO for SIGHASH_SINGLE
            if (!utxoData.utxos || utxoData.utxos.length !== 1) {
                throw new Error(`SIGHASH_SINGLE requires exactly 1 UTXO, got ${utxoData.utxos ? utxoData.utxos.length : 0}`);
            }

            const utxo = utxoData.utxos[0]; // Single UTXO

            // Create new transaction
            const tx = new mvc.Transaction();
            tx.version = 10; // MVC version

            // Add single input
            tx.from({
                txId: utxo.txId,
                outputIndex: utxo.outputIndex,
                script: utxo.script,
                satoshis: utxo.satoshis
            });

            // Add receiver output (1 satoshi)
            tx.to(userStore.last.address, 1);

            // Serialize to hex
            const txHex = tx.toString();

            // Sign the single input with SIGHASH_SINGLE
            const signResult = await window.metaidwallet.signTransaction({
                transaction: {
                    txHex: txHex,
                    address: userStore.last.address,
                    inputIndex: 0,
                    scriptHex: utxo.script,
                    satoshis: utxo.satoshis,
                    sigtype: 0x3 | 0x80 | 0x40 // SIGHASH_SINGLE | ANYONE_CAN_PAY
                }
            });

            if (!signResult || !signResult.signature || !signResult.signature.sig) {
                throw new Error('Failed to get signature');
            }

            // Build unlocking script (scriptSig) from signature
            const sig = signResult.signature.sig;
            const publicKey = signResult.signature.publicKey;

            // Build P2PKH unlocking script: <sig> <pubkey>
            const unlockingScript = mvc.Script.buildPublicKeyHashIn(
                publicKey,
                mvc.crypto.Signature.fromTxFormat(Buffer.from(sig, 'hex')).toDER(),
                0x3 | 0x80 | 0x40 // SIGHASH_SINGLE | ANYONE_CAN_PAY
            );

            // Set the unlocking script for this input
            tx.inputs[0].setScript(unlockingScript);

            // Get final signed transaction hex
            const signedTxHex = tx.toString();

            return signedTxHex;

        } catch (error) {
            console.error('Failed to build/sign MVC transaction:', error);
            throw new Error(`Failed to build/sign MVC transaction: ${error.message}`);
        }
    }

    // Direct upload
    async function directUpload(file, preTxHex, totalInputAmount, mergeTxHex) {
        try {
            const chainStore = getChainStore();
            const userStore = getUserStore();
            const constants = getConstants();

            if (!chainStore || !userStore) throw new Error('Required stores not available');

            // Build contentType
            let contentType = file.type || 'application/octet-stream';
            if (!contentType.includes(';binary')) {
                contentType = contentType + ';binary';
            }

            const path = '/file';

            // Add host information to path if provided
            const fileHost = '';
            let finalPath = path;
            if (fileHost) {
                finalPath = fileHost + ':' + path;
            }

            const formData = new FormData();
            formData.append('file', file);
            formData.append('path', finalPath);
            if (mergeTxHex) {
                formData.append('mergeTxHex', mergeTxHex);
            }
            formData.append('preTxHex', preTxHex);
            formData.append('operation', 'create');
            formData.append('contentType', contentType);
            formData.append('metaId', userStore.last.metaid);
            formData.append('address', userStore.last.address);
            formData.append('changeAddress', userStore.last.address);
            formData.append('feeRate', chainStore.mvcFeeRate().toString() || '1');
            formData.append('totalInputAmount', totalInputAmount.toString());

            // Use constants if available, otherwise fallback to API_BASE
            const apiBase = constants && constants.METAFS_API_UPLOADER 
                ? constants.METAFS_API_UPLOADER 
                : (constants && constants.METAFS_API_BASE 
                    ? constants.METAFS_API_BASE 
                    : API_BASE);

            const response = await fetch(`${apiBase}/api/v1/files/direct-upload`, {
                method: 'POST',
                body: formData,
                mode: 'cors',
                // Don't manually set Content-Type, FormData will automatically set the correct boundary
            });

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }

            const result = await response.json();

            if (result.code !== 0) {
                throw new Error(result.message);
            }

            console.log('DirectUpload success!');
            console.log('TxID:', result.data.txId);
            console.log('Status:', result.data.status);

            return result.data;
        } catch (error) {
            console.error('DirectUpload failed:', error);
            throw new Error(`DirectUpload failed: ${error.message}`);
        }
    }

    // Return public API
    return {
        uploadFileToChainDirect,
        estimateUploadFee,
        getWalletUTXOs,
        mergeUTXOs,
        buildAndSignBaseTx,
        directUpload
    };
};

