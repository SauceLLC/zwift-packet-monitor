const ZwiftPacketMonitor = require('.');
const util = require('util');
const exec = util.promisify(require('child_process').exec);


async function getPrimaryInterface() {
    const {stdout, stderr} = await exec('route get 0/0');
    if (!stdout) {
        throw new Error(stderr || 'route get failuere');
    }
    return stdout.match(/\sinterface: (.+?)$/m)[1];
}


async function main() {
    // interface is cap interface name (can be device name or IP address)
    const iface = await getPrimaryInterface();
    console.info('Monitoring zwift data from:', iface);
    const monitor = new ZwiftPacketMonitor(iface);
    monitor.on('packets', (ev, batch, ...args) => {
        console.info('end of batch', ev, batch, args);
    });
    monitor.start();
}

main();
