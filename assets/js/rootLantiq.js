const LOAD_ADDR = "80800000"
const IMAGE0_ADDR = "C0000 740000";
const IMAGE1_ADDR = "800000 800000";

async function detectUboot(serial) {
    await serial.readLine((line) => {
        if (line.startsWith('U-Boot')) {
            return true;
        }
    });
}

async function waitUbootStop(serial, sfpModel, outputMsgCallback) {
    const interruptChar = String.fromCharCode(3);

    const interval = setInterval(function() {
        serial.writeString(interruptChar);
    }, 10);

    await detectUboot(serial);
    outputMsgCallback(`Root in progress: Trigger characters received. DO NOT TOUCH THE ${sfpModel} UNTIL THE PROCEDURE IS COMPLETED!`);
    await delay(5000);
    clearInterval(interval);
}

async function checkUbootUnlocked(serial) {
    let unlocked = false;

    await serial.readLine((line) => {
        if (line.startsWith('Press SPACE to delay and Ctrl-C to abort autoboot')) {
            unlocked = true;
            return true
        }
    }, 2000);

    return unlocked;
}

async function waitFailbackShell(writer, reader, outputMsgCallback) {
    while (true) {
        const { value, done } = await reader.read();

        if (value.startsWith('Press the [f] key and hit [enter] to enter failsafe mode')) {
            const interval = setInterval(function() {
                writer.write('f\n');
            }, 10);

            outputMsgCallback("Root in progress: Trigger characters received. Waiting for boot to end...");
            await delay(3000);
            clearInterval(interval);
            break;
        }
    }

    const interval = setInterval(function() {
        writer.write(String.fromCharCode(10));
    }, 10);

    while (true) {
        const { value, done } = await reader.read();

        if (value.includes('root@(none)')) {
            await delay(1000);
            clearInterval(interval);
            break;
        }
    }
}

async function lantiqRootUboot(port, sfpModel, outputMsgCallback, outputErrorCallback, baudRate = 115200) {
    const serial = new SerialReadWrite(port, baudRate);

    try {
        outputMsgCallback(`Please disconnect the ${sfpModel} from the SFP adapter if it is currently plugged in!`);
        await delay(10000);
        outputMsgCallback(`Now you need to insert the ${sfpModel} into the SFP adapter, if the procedure does not go ahead, check the connections and then remove and reconnect the ${sfpModel} again`);

        while(true) {
            await waitUbootStop(serial, sfpModel, outputMsgCallback);
            const ubootUnlocked = await checkUbootUnlocked(serial);

            if (ubootUnlocked == true) {
                break;
            }

            outputMsgCallback("Root in progress: Set U-Boot bootdelay to 5...");
            await serial.writeString('setenv bootdelay 5\n');
            await delay(1000);
            outputMsgCallback("Root in progress: Enable ASC serial...");
            await serial.writeString('setenv asc0 0\n');
            await delay(1000);
            outputMsgCallback("Root in progress: Set GPIO to unlock serial...");
            await serial.writeString('setenv preboot "gpio set 3;gpio input 2;gpio input 105;gpio input 106;gpio input 107;gpio input 108"\n');
            await delay(1000);
            outputMsgCallback("Root in progress: Save changes...");
            await serial.writeString('saveenv\n');
            await delay(1000);
            outputMsgCallback("Root in progress: Rebooting...");
            await serial.writeString('reset\n');
            await delay(1000);
        }

        return true;
    } catch (err) {
        outputErrorCallback(`Error: ${err.message}`);
        return false;
    } finally {
        await serial.closePort();
    }
}

async function unlockHuaweiShell(port, outputMsgCallback, outputErrorCallback, baudRate = 115200) {
    let reader,writer, readableStreamClosed, writerStreamClosed;

    try {
        ({ reader, writer, readableStreamClosed, writerStreamClosed } = await openPortLineBreak(port, baudRate));
        outputMsgCallback("Root in progress: Rebooting...");
        writer.write('reset\n');
        await delay(1000);
        outputMsgCallback("Waiting for reboot");
        await waitFailbackShell(writer, reader, outputMsgCallback);
        outputMsgCallback("Root in progress: Enable full Linux shell...");
        writer.write('mount_root && mkdir -p /overlay/etc && sed "s|/opt/lantiq/bin/minishell|/bin/ash|g" /rom/etc/passwd > /overlay/etc/passwd\n');
        await delay(1000);
        outputMsgCallback("Root in progress: Umount rootfs partitions...");
        writer.write('umount /overlay && umount -a\n');
        await delay(1000);
        await closePortLineBreak(port, reader, writer, readableStreamClosed, writerStreamClosed);
        return true;
    } catch (err) {
        outputErrorCallback(`Error: ${err.message}`);
        await closePortLineBreak(port, reader, writer, readableStreamClosed, writerStreamClosed);
        return false;
    }
}

async function changeBaudrate(port, newBaudrate, currBaudrate, outputErrorCallback) {
    let reader,writer, readableStreamClosed, writerStreamClosed;

    try {
        ({ reader, writer, readableStreamClosed, writerStreamClosed } = await openPortLineBreak(port, currBaudrate));
        await writer.write(`setenv baudrate ${newBaudrate}\n`);
        await delay(1000);
        await closePortLineBreak(port, reader, writer, readableStreamClosed, writerStreamClosed);
        ({ reader, writer, readableStreamClosed, writerStreamClosed } = await openPortLineBreak(port, newBaudrate));

        const interval = setInterval(function() {
            writer.write(String.fromCharCode(13));
        }, 10);

        while (true) {
            const { value, done } = await reader.read();

            if (value.startsWith('FALCON')) {
                clearInterval(interval);
                break;
            }
        }

        await closePortLineBreak(port, reader, writer, readableStreamClosed, writerStreamClosed);
        return true;
    } catch (err) {
        outputErrorCallback(`Error: ${err.message}`);
        await closePortLineBreak(port, reader, writer, readableStreamClosed, writerStreamClosed);
        return false;
    }
}

async function sendImageMtd(port, data, baudRate, outputErrorCallback, progressCallback) {
    let reader,writer, readableStreamClosed, writerStreamClosed;

    try {
        ({ reader, writer, readableStreamClosed, writerStreamClosed } = await openPortLineBreak(port, baudRate));
        await writer.write(`loady 0x${LOAD_ADDR}\n`);
        await delay(1000);
        await closePortLineBreak(port, reader, writer, readableStreamClosed, writerStreamClosed);   /* XYMini needs reopen the port */
    } catch (err) {
        outputErrorCallback(`Error: ${err.message}`);
        await closePortLineBreak(port, reader, writer, readableStreamClosed, writerStreamClosed);
        return false;
    }

    try {
        await port.open({ baudRate: baudRate });
        reader = port.readable.getReader();
        writer = port.writable.getWriter();

        await sendXYMini(reader, writer, data, baudRate, progressCallback);
        await reader.cancel();
        await writer.close();
        await port.close();
        return true;
    } catch (err) {
        await reader.cancel();
        await writer.close();
        await port.close();
        outputErrorCallback(`Error: ${err.message}`);
        return false;
    }
}

async function waitEndImageLoad(port, baudRate, outputErrorCallback) {
    let reader, writer, readableStreamClosed, writerStreamClosed;

    try {
        ({ reader, writer, readableStreamClosed, writerStreamClosed } = await openPortLineBreak(port, baudRate));

        while (true) {
            const { value, done } = await reader.read();

            if (value.includes('Total Size')) {
                break;
            }
        }

        await delay(1000);
        await closePortLineBreak(port, reader, writer, readableStreamClosed, writerStreamClosed);
        return true;
    } catch (err) {
        outputErrorCallback(`Error: ${err.message}`);
        await closePortLineBreak(port, reader, writer, readableStreamClosed, writerStreamClosed);
        return false;
    }
}

async function flashImageMtd(port, image, baudRate, outputErrorCallback) {
    let reader, writer, readableStreamClosed, writerStreamClosed;

    try {
        ({ reader, writer, readableStreamClosed, writerStreamClosed } = await openPortLineBreak(port, baudRate));
        if (image == "image0") {
            await writer.write(`sf probe 0 && sf erase ${IMAGE0_ADDR} && sf write ${LOAD_ADDR} ${IMAGE0_ADDR} && setenv committed_image 0 && setenv image0_is_valid 1 && saveenv && reset\n`);
        } else {
            await writer.write(`sf probe 0 && sf erase ${IMAGE1_ADDR} && sf write ${LOAD_ADDR} ${IMAGE1_ADDR} && setenv committed_image 1 && setenv image1_is_valid 1 && saveenv && reset\n`);
        }
    } catch (err) {
        outputErrorCallback(`Error: ${err.message}`);
        return false;
    } finally {
        await closePortLineBreak(port, reader, writer, readableStreamClosed, writerStreamClosed);
    }

    const serial = new SerialReadWrite(port, baudRate);
    try {
        /* Wait to avoid the user from disconnecting the SFP while the image is being flashed */
        await delay(1000);
        await detectUboot(serial);
        return true;
    } catch (err) {
        outputErrorCallback(`Error: ${err.message}`);
        return false;
    } finally {
        await serial.closePort();
    }
}
