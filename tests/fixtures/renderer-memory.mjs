// Exercise the renderer caches directly, without a test terminal retaining frames.
// The old Ink caches retained every unique streaming-text update for process life.
const ink = new URL(import.meta.resolve('ink'));
const { default: measureText } = await import(new URL('measure-text.js', ink));
const { default: wrapText } = await import(new URL('wrap-text.js', ink));
const samples = [];
for (let batch = 0; batch < 3; batch++) {
  for (let index = 0; index < 8192; index++) {
    const text = `${batch}:${index} ` + 'streamed reply with code and status updates '.repeat(40);
    measureText(text);
    wrapText(text, 110, 'truncate');
  }
  global.gc();
  samples.push(process.memoryUsage().heapUsed);
}
console.log(JSON.stringify({ samples }));
