const ZwiftPacketMonitor = require('.');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const athleteCache = path.resolve(os.homedir(), '.zwiftAthleteCache.json');


async function getAthleteCache() {
    let f;
    try {
        f = await fs.open(athleteCache);
    } catch(e) {
        if (e.code !== 'ENOENT') {
            throw e;
        }
        return new Map();
    }
    const data = new Map(JSON.parse(await f.readFile()));
    await f.close();
    return data;
}


async function setAthleteCache(data) {
    const tmp = athleteCache + '.tmp';
    const f = await fs.open(tmp, 'w');
    await f.writeFile(JSON.stringify(Array.from(data)));
    await f.close();
    await fs.rename(tmp, athleteCache);
}


async function getPrimaryInterface() {
    const {stdout, stderr} = await exec('route get 0/0');
    if (!stdout) {
        throw new Error(stderr || 'route get failuere');
    }
    return stdout.match(/\sinterface: (.+?)$/m)[1];
}


async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}


async function main() {
    // interface is cap interface name (can be device name or IP address)
    const athletes = await getAthleteCache();
    const iface = await getPrimaryInterface();
    console.info('Monitoring zwift data from:', iface);
    const monitor = new ZwiftPacketMonitor(iface);
    //const athletes = new Map();
    monitor.on('incoming', packet => {
        let added = 0;
        let existing = 0;
        for (x of packet.player_updates) {
            if (x.payload && x.payload.$type && x.payload.$type.name === 'PlayerEnteredWorld') {
                if (athletes.has(x.payload.athlete_id)) {
                    existing++;
                } else {
                    added++;
                }
                athletes.set(x.payload.athlete_id, x.payload.toJSON());
            }
        }
        if (added) {
            console.warn("Added athletes:", added, athletes.size);
        }
        if (existing) {
            console.warn("Updated athletes:", existing, athletes.size);
        }
        let missing = 0;
        let found = 0;
        for (x of packet.player_states) {
            if (!athletes.has(x.id)) {
                missing++;
            } else {
                const athlete = athletes.get(x.id);
                found++;
                //console.info("Suwheet we do have this one:", x.id, athlete.firstName, athlete.lastName);
            }
        }
        if (missing || found) {
            console.warn("HIT/MISS:", found, missing);
        }
    });
    monitor.on('outgoing', packet => {
        //console.error("OUT Packet:", packet);  // XXX parse me
    });
    monitor.start();
    while (true) {
        await sleep(1);
        await setAthleteCache(athletes);
    }
}

main();
