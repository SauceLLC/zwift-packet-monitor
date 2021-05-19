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
    const athletes = new Map();
    monitor.on('incoming', packet => {
        for (x of packet.player_updates) {
            if (x.payload && x.payload.$type && x.payload.$type.name === 'PlayerEnteredWorld') {
                athletes.set(x.payload.athlete_id, x.payload.toJSON());
            }
        }
        for (x of packet.player_states) {
            if (!athletes.has(x.id)) {
                //console.warn("Nah brahj, we don't have dis one!", x.id);
            } else {
                const athlete = athletes.get(x.id);
                //console.info("Suwheet we do have this one:", x.id, athlete.firstName, athlete.lastName);
            }
        }
    });
    monitor.on('outgoing', packet => {
        console.error("OUT Packet:", packet);  // XXX parse me 
    });
    monitor.start();
}

main();
