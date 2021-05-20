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
    // XXX macos only.
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
    const athletes = await getAthleteCache();
    const iface = await getPrimaryInterface();
    console.info('Monitoring zwift data from:', iface);
    const monitor = new ZwiftPacketMonitor(iface);
    const states = new Map();
    let watching;
    monitor.on('incoming', packet => {
        let added = 0;
        let existing = 0;
        for (x of packet.playerUpdates) {
            if (x.payload && x.payload.$type) {
                if (x.payload.$type.name === 'PlayerEnteredWorld') {
                    if (athletes.has(x.payload.athleteId)) {
                        existing++;
                    } else {
                        added++;
                    }
                    athletes.set(x.payload.athleteId, x.payload.toJSON());
                } else if (x.payload.$type.name === 'Event') {
                    console.warn("Route debug (verify this):", x.payload);
                } else if (x.payload.$type.name === 'EventJoin') {
                    console.warn("Event Join:", x.payload);
                } else if (x.payload.$type.name === 'EventLeave') {
                    console.warn("Event Leave:", x.payload);
                } else if (x.payload.$type.name === 'ChatMessage') {
                    console.warn("Chat:", x.payload);
                } else if (x.payload.$type.name === 'RideOn') {
                    console.warn("RideOn:", x.payload);
                }
            }
        }
        if (added) {
            //console.warn("Added athletes:", added, athletes.size);
        }
        if (existing) {
            //console.warn("Updated athletes:", existing, athletes.size);
        }
        let missing = 0;
        let found = 0;
        for (x of packet.playerStates) {
            const athlete = athletes.get(x.id);
            if (!athlete) {
                missing++;
            } else {
                found++;
                //console.info("Suwheet we do have this one:", x.id, athlete.firstName, athlete.lastName);
            }
            states.set(x.id, x);
        }
        if (missing || found) {
            //console.warn("HIT/MISS:", found, missing);
        }
    });
    monitor.on('outgoing', packet => {
        if (!packet.state) {
            return;
        }
        watching = packet.state.watchingAthleteId;
        states.set(packet.athleteId, packet.state);
    });
    monitor.start();
    while (true) {
        await sleep(1000);
        await setAthleteCache(athletes);
        if (watching) {
            const athlete = athletes.get(watching);
            const state = states.get(watching);
            console.debug("Athletes:", athletes.size, "States:", states.size);
            console.debug("Watching:", athlete);
            console.debug("State:", state.toJSON());
        }
    }
}

main();
