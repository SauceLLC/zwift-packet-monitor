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


function headingConv(microRads) {
    if (microRads < Math.PI * -1000000 || microRads > Math.PI * 3000000) {
        debugger;
    }
    halfCircle = 1000000 * Math.PI;
    return (((microRads + halfCircle) / (2 * halfCircle)) * 360) % 360;
}


let minHeading = Infinity;
let maxHeading = -Infinity;
function distance(a, b) {
    minHeading = Math.min(minHeading, a.heading, b.heading);
    maxHeading = Math.max(maxHeading, a.heading, b.heading);
    (headingConv(a.heading), headingConv(b.heading), headingConv(minHeading), headingConv(maxHeading));
    return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2) / 100;  // roughly meters
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
                } else if (x.payload.$type.name === 'EventJoin') {
                    console.warn("Event Join:", x.payload);
                } else if (x.payload.$type.name === 'EventLeave') {
                    console.warn("Event Leave:", x.payload);
                } else if (x.payload.$type.name === 'ChatMessage') {
                    console.warn("Chat:", x.payload.firstName, x.payload.lastName, ':', x.payload.message);
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
        if (!watching) {
            // Fallback for when we are just watching or not hooked up with power.
            watching = packet.athleteId;
        }
        for (x of packet.playerStates) {
            const athlete = athletes.get(x.id);
            if (!athlete) {
                missing++;
            } else {
                found++;
            }
            states.set(x.id, x);
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
    console.clear();
    while (true) {
        if (!watching) {
            await sleep(100);
            continue;
        }
        const nearby = [];
        const athlete = athletes.get(watching);
        const state = states.get(watching);
        if (state) {
            console.debug("Heading range:", minHeading, maxHeading);
            console.debug("Athletes:", athletes.size, "States:", states.size);
            console.debug("Watching:", athlete.athleteId, headingConv(state.heading));
            const statePos = state.roadTime * ((state.flags1 & state.$type.getEnum('Flags1').REVERSE) ? -1 : 1);
            const now = Date.now();
            for (const [id, x] of states.entries()) {
                if (now - x.date > 10000) {
                    console.info("Stale entry:", x);
                    states.delete(id);
                    continue;
                }
                if (state.groupId && x.groupId === state.groupId) {
                    console.info("Skip rider from other group", state.groupId);
                    continue;
                }
                headingConv(x.heading);
                const dist = distance(x, state);
                const reverse = (x.flags1 & state.$type.getEnum('Flags1').REVERSE) ? -1 : 1;
                //if (x.roadId === state.roadId) {
                nearby.push({dist, relPos: statePos - (x.roadTime * reverse), state: x});
                //}
            }
            nearby.sort((a, b) => b.relPos - a.relPos);
            const center = nearby.findIndex(x => x.state.id === watching);
            for (let i = Math.max(0, center - 8); i < Math.min(nearby.length, center + 8); i++) {
                const x = nearby[i];
                const eta = x.dist / (state.speed / 1000 / 3600);
                console.debug('Leaderboard:', i - center, Math.round(x.dist), 'm', (x.state.speed / 1000000).toFixed(1), 'kph', 'eta:', Math.round(eta), 'relPos:', x.relPos, 'flags...', x.state.flags1.toString(16), x.state.flags2.toString(16), 'name:', athletes.get(x.state.id)?.lastName, headingConv(x.state.heading).toFixed(1));
            }
        }
        await sleep(2000);
        await setAthleteCache(athletes);
    }
}

main();
