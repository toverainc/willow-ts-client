![](docs/icon.png)

# Willow TS Client

This repo contains the TypeScript client for interacting with Willow's WebRTC component. Detailed docs can be [found here](https://toverainc.github.io/willow-ts-client/).

## Installation

```bash
npm install @tovera/willow-ts-client
```

## Basic Usage

```typescript
import { WillowClient } from '@tovera/willow-ts-client'
const client = new WillowClient({ host: "http://localhost:19000/api/rtc/asr" })
client.on('onOpen', () => {
  console.log('Connection open. Recording for 30 seconds.')
  client.start()
  setTimeout(()=>client.stop(), 30*1000)
})
client.on('onLog', (log) => {
  console.log('Verbose server log: ' + log)
})
client.on('onError', (err) => {
  console.error('Willow WebRTC Error', err)
})
client.on('onInfer', (msg) => {
  console.log(`Got result ${msg.text} in ${msg.time}ms`)
})
await client.init();
```
