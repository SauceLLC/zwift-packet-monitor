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
        this._cap = new Cap();
        this._linkType = null;
        this._sequence = 0;
        this._tcpBuffers = [];
        if (interfaceName.match(/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/)) {
            this._interfaceName = Cap.findDevice(interfaceName);
        } else {
            this._interfaceName = interfaceName;
        }
    }

    start () {
        this._capBuf = new Buffer.alloc(65535);
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
                if (![110, 106, 102, 109, 108, 114].includes(x.payloadType)) {
                    debugger;
                    console.warn('No payload message for:', x.payloadType);
                }
            } else {
                try {
                    x.payloadBuf = x.payload; // XXX
                    x.payload = PayloadMsg.decode(x.payloadBuf);
                } catch(e) {
                    console.error('Payload processing error:', e, PayloadMsg, x.payloadType, x.payloadBuf);
                    debugger;
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
            if (udp.info.srcport === 3022) {
                const packet = IncomingPacket.decode(this._capBuf.slice(udp.offset, udp.offset + udp.info.length));
                /*
                   if (this._sequence) {
                   if (packet.seqno > this._sequence + 1) {
                   console.warn(`Missing packets - expecting ${this._sequence + 1}, got ${packet.seqno}`)
                   } else if (packet.seqno < this._squence) {
                   console.warn(`Delayed packet - expecting ${this._sequence + 1}, got ${packet.seqno}`)
                   return
                   }
                   }
                   this._sequence = packet.seqno
                */
                this._handleIncomingPacket(packet);
            } else if (udp.info.dstport === 3022) {
                // 2020-11-14 extra handling added to handle what seems to be extra information preceeding the protobuf
                let skip = 5; // uncertain if this number should be fixed or
                // ...if the first byte(so far only seen with value 0x06)
                // really is the offset where protobuf starts, so add some extra checks just in case:
                if (this._capBuf.slice(udp.offset + skip, udp.offset + skip + 1).equals(Buffer.from([0x08]))) {
                    // protobuf does seem to start after skip bytes
                } else if (this._capBuf.slice(udp.offset, udp.offset + 1).equals(Buffer.from([0x08]))) {
                    // old format apparently, starting directly with protobuf instead of new header
                    skip = 0;
                } else {
                    // use the first byte to determine how many bytes to skip
                    skip = this._capBuf.slice(udp.offset, udp.offset + 1).readUIntBE(0, 1) - 1;
                }
                const packet = OutgoingPacket.decode(this._capBuf.slice(udp.offset + skip,
                    udp.offset + udp.info.length - 4));
                if (packet.worldTime.toNumber()) {
                    packet.date = worldTimeToDate(packet.worldTime);
                    if (Math.abs(Date.now() - packet.date.getTime()) > 200) {
                        console.warn('Clock drift from worldTime exceeded 200ms:',
                            Date.now() - packet.date.getTime());
                    }
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


module.exports = ZwiftPacketMonitor
