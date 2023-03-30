import EventEmitter from "events"
import TypedEmitter from "typed-emitter"

export type AirClientEvents = {
  onLog: (msg: string) => void,
  onVerboseLog: (msg: string) => void,
  onInfer: (results: { text: string, time: number }) => void,
  onClose: () => void;
  onOpen: () => void;
}

export interface AirClientConfig extends RTCConfiguration {
  sdpSemantics?: "plan-b" | "unified-plan",
  constraints?: MediaStreamConstraints,
  rtcConfig?: RTCConfiguration,
  host?: string, //e.g. http://localhost:19000
}

export default class AirClient extends (EventEmitter as new () => TypedEmitter<AirClientEvents>) {
  config: AirClientConfig
  pc: RTCPeerConnection
  dc: RTCDataChannel
  stream: MediaStream | undefined
  private lastStop: number = 0
  constructor(config: AirClientConfig) {
    super()
    config = config || {}
    config.rtcConfig = Object.assign({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
      sdpSemantics: "unified-plan",
    }, config.rtcConfig)
    config.constraints = config.constraints || { audio: true, video: false };
    config.host = config.host || ''
    this.config = config
    this.pc = new RTCPeerConnection(config)
    const pc = this.pc;
    this.dc = this.pc.createDataChannel('chat', { 'ordered': true })

    pc.addEventListener('icegatheringstatechange', ()=>this.emit('onVerboseLog', `iceGatheringLog ${pc.iceGatheringState}`))
    pc.addEventListener('iceconnectionstatechange', ()=>this.emit('onVerboseLog', `iceConnectionLog ${pc.iceGatheringState}`))
    pc.addEventListener('signalingstatechange', ()=>this.emit('onVerboseLog', `signalingLog ${pc.iceGatheringState}`))
  }

  get track(): MediaStreamTrack | undefined {
    return this.stream && this.stream.getTracks()[0]
  }

  get sender(): RTCRtpSender | undefined {
    return this.pc.getSenders()[0]
  }

  async mute(mute: boolean) {
    if (!this.sender || !this.stream) return;
    await this.sender.replaceTrack(mute ? null : this.track)
  }

  async start() {
    await this.mute(false)
    await this.dc.send('start')
  }

  async stop() {
    this.lastStop = new Date().getTime()
    await Promise.all([
      this.dc.send("stop:large:5:False"),
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
      await this.dc.send("disconnecting");
      this.dc.close();
    } catch (error) {
      this.emit('onLog', "No DC to close")
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
      this.emit('onLog', evt.data)
      const data: string = evt.data
      if (data.includes('Infer')) {
        this.emit('onInfer', {
          text: evt.data,
          time: new Date().getTime() - this.lastStop
        })
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

  async negotiate(timout: number = 30000) {
    const pc = this.pc
    await pc.setLocalDescription(await pc.createOffer());
    //wait for ICE gathering to complete
    await new Promise<void>(function (resolve, reject) {
      if (pc.iceGatheringState === 'complete') {
        resolve();
      } else {
        function checkState() {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', checkState);
            resolve();
          }
        }
        pc.addEventListener('icegatheringstatechange', checkState);
      }
      setTimeout(() => reject('ICE gathering timed out'), timout)
    })
    const offer = pc.localDescription;
    this.emit('onVerboseLog', `offer ${JSON.stringify(offer, null, 2)}`)
    const codec = 'opus/48000/2';
    (offer as any).sdp = sdpFilterCodec('audio', codec, offer.sdp);

    // The route in FastAPI supports all of the usual URL params to control ASR
    const answer = await (await fetch(`${this.config.host}/api/rtc/asr?model=large`, {
      body: JSON.stringify({
        sdp: offer.sdp,
        type: offer.type
      }),
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'POST'
    })).json();
    await pc.setRemoteDescription(answer)
  }
}
(global as any).AirClient = AirClient

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

function escapeRegExp(str:string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}