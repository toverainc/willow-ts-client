import EventEmitter from "events"
import TypedEmitter from "typed-emitter"

export type WillowClientEvents = {
    onLog: (msg: string) => void,
    onError: (msg: string) => void,
    onMessage: (msg: DataChannelMessage) => void,
    onInfer: (results: { text: string, time: number }) => void,
    onClose: () => void;
    onOpen: () => void;
}

export interface WillowClientConfig {
    constraints?: MediaStreamConstraints,
    rtcConfig?: RTCConfiguration,
    host?: string, //e.g. http://localhost:19000
}

export interface DataChannelMessage<T = any> {
    type: string,
    message?: string,
    obj?: T;
}

export default class WillowClient extends (EventEmitter as new () => TypedEmitter<WillowClientEvents>) {
    config: WillowClientConfig
    pc: RTCPeerConnection
    dc: RTCDataChannel
    stream: MediaStream | undefined
    private lastStop: number = 0
    recording: boolean = false
    constructor(config: WillowClientConfig) {
        super()
        config = config || {}
        config.rtcConfig = Object.assign({
            iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
            sdpSemantics: "unified-plan",
        }, config.rtcConfig)
        config.constraints = config.constraints || { audio: true, video: false };
        config.host = config.host || ''
        this.config = config
        this.pc = new RTCPeerConnection(config.rtcConfig)
        const pc = this.pc;
        this.dc = this.pc.createDataChannel('chat', { 'ordered': true })

        pc.addEventListener('icegatheringstatechange', () => this.emit('onLog', `iceGatheringLog ${pc.iceGatheringState}`))
        pc.addEventListener('iceconnectionstatechange', () => this.emit('onLog', `iceConnectionLog ${pc.iceConnectionState}`))
        pc.addEventListener('signalingstatechange', () => this.emit('onLog', `signalingLog ${pc.iceGatheringState}`))
    }

    get track(): MediaStreamTrack | undefined {
        return this.stream && this.stream.getTracks()[0]
    }

    get sender(): RTCRtpSender | undefined {
        return this.pc.getSenders()[0]
    }

    get connected(): boolean {
        return this.dc.readyState === "open"
    }

    async mute(mute: boolean) {
        if (!this.sender || !this.stream) return;
        await this.sender.replaceTrack(mute ? null : this.track)
    }

    async start() {
        if (this.recording) return;
        this.recording = true;
        await this.mute(false)
        await this.sendMessage({ type: 'start' })
    }

    async sendMessage(message: DataChannelMessage) {
        if (!message.type) throw new Error("DataChannelMessage must have a type");
        await this.dc.send(JSON.stringify(message))
    }

    async stop() {
        if (!this.recording) return;
        this.recording = false;
        this.lastStop = new Date().getTime()
        await Promise.all([
            this.sendMessage({ type: "stop", obj: { model: "large", beam_size: 5, detect_language: false } }),
            //this.sendMessage({ type: "stop" }), //XXX: bug in server makes this not work
            this.mute(true),
        ])
    }

    async disconnect() {
        try {
            this.pc.getSenders().forEach((sender) => sender.track.stop());
        } catch {
            this.emit('onLog', "No sender tracks to stop")
        }

        try {
            this.pc.getTransceivers().forEach((transceiver) => transceiver.stop && transceiver.stop());
        } catch (error) {
            this.emit('onLog', "No Transceivers to stop")
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 500)) //sleep 500
        try {
            this.pc.close()
            this.emit('onLog', "Disconnected")
        } catch (error) {
            this.emit('onLog', "No peer connection to close")
        }
    }

    async init() {
        const pc = this.pc;
        const dc = this.dc;
        dc.onclose = () => {
            this.emit('onClose')
            this.emit('onLog', 'Disconnected from ASR Service')
        }
        dc.onopen = () => {
            this.emit('onOpen')
            this.emit('onLog', 'Connected to ASR Service - start recording whenever you like')
        }
        dc.onmessage = (evt) => {
            try {
                var message = JSON.parse(evt.data) as DataChannelMessage
            } catch (error) {
                this.emit('onError', `Error parsing data channel message. "${evt.data}"`)
                return
            }
            if (!message.type) {
                this.emit('onError', `Data channel message does not have a type. "${evt.data}"`)
                return;
            }
            this.emit('onMessage', message)
            if (message.type == "log") {
                this.emit('onLog', message.message)
            } else if (message.type == "infer") {
                this.emit('onInfer', Object.assign(message.obj, { time: new Date().getTime() - this.lastStop }))
            } else if (message.type == "error") {
                this.emit('onError', message.message)
            } else {
                this.emit('onError', `Unknown Data channel message type, "${message.type}"`)
            }
        }

        try {
            this.stream = await navigator.mediaDevices.getUserMedia(this.config.constraints)
        } catch (error) {
            this.emit('onLog', `Failed to getUserMedia: ${error}`)
            throw error
        }
        for (const track of this.stream.getTracks()) {
            pc.addTrack(track)
            this.emit('onLog', 'added track to peer connection')
        }
        await this.negotiate()
        await this.mute(true)
    }

    async negotiate(attempts: number = 4, attemptBackoff: number = 5000) {
        const pc = this.pc
        const start = +new Date()
        await pc.setLocalDescription(await pc.createOffer());
        for (let attempt = 1; attempt <= attempts; attempt++) {
            //wait for ICE gathering to complete
            await new Promise<void>(function (resolve, reject) {
                if (pc.iceGatheringState === 'complete') {
                    return resolve();
                }
                const checkState = () => {
                    let shouldEarlyAttempt = attempt < attempts && (+new Date() - start > attempt * attemptBackoff)
                    if (pc.iceGatheringState === 'complete' || shouldEarlyAttempt) {
                        pc.removeEventListener('icegatheringstatechange', checkState);
                        pc.removeEventListener('icecandidate', checkState);
                        resolve();
                    }
                }
                pc.addEventListener('icegatheringstatechange', checkState);
                pc.addEventListener('icecandidate', checkState);
                setTimeout(checkState, attemptBackoff + Math.random() * 200)
                setTimeout(() => reject('ICE gathering timed out'), 10 * 60 * 1000) //sanity fail
            })
            const offer = pc.localDescription;
            this.emit('onLog', `localDescription offer ${JSON.stringify(offer, null, 2)}`)
            const codec = 'opus/48000/2';
            (offer as any).sdp = sdpFilterCodec('audio', codec, offer.sdp);

            // The route in FastAPI supports all oftyped-emitter the usual URL params to control ASR
            try {
                const controller = new AbortController();
                const id = setTimeout(() => controller.abort(), 30 * 1000);
                var answer = await (await fetch(`${this.config.host}`, {
                    method: 'POST',
                    body: JSON.stringify({
                        sdp: offer.sdp,
                        type: offer.type
                    }),
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                })).json();
                clearTimeout(id)
                break; //success... return
            } catch (error) {
                this.emit('onLog', `negotiate attempt #${attempt} failed`)
            }
        }
        if (!answer) {
            const msg = 'Could not complete negotiation with server'
            this.emit('onError', msg)
            throw new Error(msg)
        }
        await pc.setRemoteDescription(answer)
    }
}
//(global as any).WillowClient = WillowClient

function sdpFilterCodec(kind: 'audio', codec: string, realSdp: string) {
    var allowed = []
    var rtxRegex = new RegExp('a=fmtp:(\\d+) apt=(\\d+)\r$');
    var codecRegex = new RegExp('a=rtpmap:([0-9]+) ' + escapeRegExp(codec))
    var videoRegex = new RegExp('(m=' + kind + ' .*?)( ([0-9]+))*\\s*$')

    var lines = realSdp.split('\n');

    var isKind = false;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('m=' + kind + ' ')) {
            isKind = true;
        } else if (lines[i].startsWith('m=')) {
            isKind = false;
        }

        if (isKind) {
            var match = lines[i].match(codecRegex);
            if (match) {
                allowed.push(parseInt(match[1]));
            }

            match = lines[i].match(rtxRegex);

            if (match && allowed.includes(parseInt(match[2]))) {
                allowed.push(parseInt(match[1]));
            }
        }
    }

    var skipRegex = 'a=(fmtp|rtcp-fb|rtpmap):([0-9]+)';
    var sdp = '';

    isKind = false;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('m=' + kind + ' ')) {
            isKind = true;
        } else if (lines[i].startsWith('m=')) {
            isKind = false;
        }

        if (isKind) {
            var skipMatch = lines[i].match(skipRegex);
            if (skipMatch && !allowed.includes(parseInt(skipMatch[2]))) {
                continue;
            } else if (lines[i].match(videoRegex)) {
                sdp += lines[i].replace(videoRegex, '$1 ' + allowed.join(' ')) + '\n';
            } else {
                sdp += lines[i] + '\n';
            }
        } else {
            sdp += lines[i] + '\n';
        }
    }

    //console.log(`Processed SDP is ${sdp}`)
    sdp = sdp.replace('minptime=10;useinbandfec=1', 'minptime=10;useinbandfec=1;sprop-maxcapturerate=16000;stereo=0')
    //console.log(`16kHz SDP is ${sdp}`)
    return sdp;
}

function escapeRegExp(str: string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}
