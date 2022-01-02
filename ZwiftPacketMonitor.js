const EventEmitter = require('events');
const cap = require('cap');
const Cap = cap.Cap;
const decoders = cap.decoders;
const PROTOCOL = decoders.PROTOCOL;
const fs = require('fs');
const protobuf = require('protobufjs');
const zpb = protobuf.parse(fs.readFileSync(`${__dirname}/zwiftMessages.proto`),
    {keepCase: true}).root;

const IncomingPacket = zpb.get('IncomingPacket');
const OutgoingPacket = zpb.get('OutgoingPacket');


let worldTimeOffset = 1414016074335;  // ms since zwift started production.
function worldTimeToDate(wt) {
    // TBD I think timesync helps us adjust the offset but I can't interpret it yet.
    return new Date(worldTimeOffset + Number(wt));
}


class ZwiftPacketMonitor extends EventEmitter {
    constructor (interfaceName) {
        super();
        this._linkType = null;
        this._inUDPSequences = new Map();
        this._tcpBuffers = [];
        if (interfaceName.match(/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/)) {
            this._interfaceName = Cap.findDevice(interfaceName);
        } else {
            this._interfaceName = interfaceName;
        }
    }

    start () {
        this._capBuf = new Buffer.alloc(65535);
        this._cap = new Cap();
        this._linkType = this._cap.open(this._interfaceName, 'udp port 3022 or tcp port 3023',
                10 * 1024 * 1024, this._capBuf);
        this._cap.setMinBytes && this._cap.setMinBytes(0);
        this._cap.on('packet', this.processPacket.bind(this));
    }

    stop () {
        this._cap.close();
    }

    _handleIncomingPacket(packet) {
        for (const x of packet.playerUpdates) {
            const PayloadMsg = zpb.get(x.$type.getEnum('PayloadType')[x.payloadType]);
            if (!PayloadMsg) {
                if (x.payloadType === 100 || x.payloadType === 101) {
                    // These appear to LE floats.  Perhaps some latency reports (values of ~0.2 or ~4.2 observed)
                    x._XXX_maybe_latency_report = x.payload.readFloatLE();
                    console.warn("XXX Possible latency report?:", x.XXX_maybe_latency_report);
                } else if (x.payloadType === 116) {
                    // Looks like 4 64bit numbers, but not sure what they represent. Interval is 30seconds
                    if (x.payload.byteLength !== 32) {
                        console.warn('Unexpected payload size for type 116', x.payload.byteLength);
                    } else {
                        x._XXX_116_num1 = x.payload.readBigInt64LE(0);
                        x._XXX_116_num2 = x.payload.readBigInt64LE(8);
                        x._XXX_116_num3 = x.payload.readBigInt64LE(16);
                        x._XXX_116_num4 = x.payload.readBigInt64LE(24);
                        console.warn("What are these? XXX", x._XXX_116_num1, x._XXX_116_num2,
                            x._XXX_116_num3, x._XXX_116_num4, x.payload);
                    }
                } else if (![110, 106, 102, 109, 108, 114].includes(x.payloadType)) {
                    console.warn('No payload message for:', x.payloadType, x.payload);
                }
            } else {
                x.payloadBuf = x.payload; // XXX makes debug easier
                try {
                    x.payload = PayloadMsg.decode(x.payloadBuf);
                } catch(e) {
                    console.error('Payload processing error:', e, PayloadMsg, x.payloadType, x.payloadBuf);
                    throw e;
                }
            }
        }
        setTimeout(() => this.emit('incoming', packet), 0);
    }

    copyCapBufSlice(start, end) {
        // Buffer.slice uses existing ArrayBuffer source, we need a real copy when buffering.
        return Uint8Array.prototype.slice.call(this._capBuf, start, end);
    }

    processPacket() {
        try {
            this._processPacket();
        } catch(e) {
            console.error('Packet processing error:', e);
        }
    }

    _validateIncomingUDP(packet, conn) {
        if (this._inUDPSequences.has(conn)) {
            const last = this._inUDPSequences.get(conn);
            if (packet.seqno > last + 1) {
                console.warn(`${packet.seqno - (last + 1)} packet(s) were dropped or delayed`);
            } else if (packet.seqno < last + 1) {
                console.warn(`Ignoring delayed packet`, packet.seqno);
                return false;
            }
        }
        this._inUDPSequences.set(conn, packet.seqno);
        return true;
    }

    _processPacket() {
        if (this._linkType !== 'ETHERNET') {
            return;
        }
        const eth = decoders.Ethernet(this._capBuf);
        if (eth.info.type !== PROTOCOL.ETHERNET.IPV4) {
            return;
        }
        const ip = decoders.IPV4(this._capBuf, eth.offset);
        if (ip.info.protocol === PROTOCOL.IP.UDP) {
            const udp = decoders.UDP(this._capBuf, ip.offset);
            const buf = this._capBuf.slice(udp.offset, udp.offset + udp.info.length);
            if (udp.info.srcport === 3022) {
                const packet = IncomingPacket.decode(buf);
                if (!this._validateIncomingUDP(packet, `${ip.info.srcaddr}:${udp.info.dstport}`)) {
                    console.warn(`Ignoring invalid packet`, packet.seqno);
                    return
                }
                this._handleIncomingPacket(packet);
            } else if (udp.info.dstport === 3022) {
                let skip;
                // Bunch of strange stuff, newest -> oldest seen.
                if (buf[0] === 0xdf) {
                    skip = 1;
                } else if (buf[0] === 0x06) {
                    skip = 5;
                } else if (buf[0] === 0x08) {
                    skip = 0;
                } else {
                    console.error("Invalid outgoing packet", buf.slice(0, 10));
                    return;
                }
                // Last four bytes of outgoing data are also non-protobuf.
                let packet;
                try {
                    packet = OutgoingPacket.decode(buf.slice(skip, -4));
                } catch(e) {
                    console.error("OUTGOING DECODE ERROR:", buf.slice(0, 100));
                    return;
                }
                if (packet.worldTime.toNumber()) {
                    packet.date = worldTimeToDate(packet.worldTime);
                }
                setTimeout(() => this.emit('outgoing', packet), 0);
            }
        } else if (ip.info.protocol === PROTOCOL.IP.TCP) {
            const tcp = decoders.TCP(this._capBuf, ip.offset);
            if (tcp.info.srcport !== 3023) {
                return;
            }
            const datalen = ip.info.totallen - tcp.hdrlen - ip.hdrlen;
            const PSH = !!(tcp.info.flags & 0x08);  // Push means process the buffer
            if (PSH) {
                // Buffer.slice is zero-copy, so only safe on final buffer.
                this._tcpBuffers.push(this._capBuf.slice(tcp.offset, tcp.offset + datalen));
                // The assembled TCP payload contains one or more messages:
                //    <msg len> <msg> [<msg len> <msg>]...
                const buf = Buffer.concat(this._tcpBuffers);
                this._tcpBuffers.length = 0;
                let offt = 0;
                while (offt < buf.byteLength) {
                    const msgLen = buf.readUInt16BE(offt);
                    offt += 2;
                    if (buf.byteLength - offt < msgLen) {
                        console.error("Short buffer", buf.byteLength - offt, msgLen);
                        throw new TypeError('short buffer');
                    }
                    this._handleIncomingPacket(IncomingPacket.decode(buf.slice(offt, offt + msgLen)));
                    offt += msgLen;
                }
            } else {
                // Make a proper copy of the buffer, i.e. !Buffer.slice
                this._tcpBuffers.push(this.copyCapBufSlice(tcp.offset, tcp.offset + datalen));
            }
        }
    }
}


module.exports = ZwiftPacketMonitor;
