/** Runtime tier: real Electron input through cross-origin + same-origin iframes.
 * Run with node apps/desktop/scripts/native-trackpad.verify.mjs.
 * The AppKit source is substituted with recorded normalized contacts: this does
 * not claim physical-trackpad verification. No Cindy profile is opened. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Optional interactive acceptance window, backed by the same production input
// module and the real addon. The URL file avoids printing viewer credentials.
const viewerFile =
  !process.versions.electron && process.argv[2] === '--viewer' ? process.argv[3] : undefined;
if (!process.versions.electron) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-trackpad-verify-'));
  try {
    require('esbuild').buildSync({
      entryPoints: [path.join(desktop, 'src/main/nativeTrackpad.ts')],
      outfile: path.join(temp, 'input.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    const env = { ...process.env };
    env.CINDY_TRACKPAD_VERIFY_CONTACTS = process.argv.includes('--contacts') ? '1' : '0';
    env.CINDY_TRACKPAD_EXERCISE = process.argv.includes('--exercise') ? '1' : '0';
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(
      require('electron'),
      [fileURLToPath(import.meta.url), temp, ...(viewerFile ? [path.resolve(viewerFile)] : [])],
      {
        env,
        stdio: 'inherit',
        timeout: viewerFile ? undefined : 30000,
      },
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} else {
  void (async () => {
    const { app, BrowserWindow } = require('electron');
    const temp = process.argv[2];
    app.setPath('userData', path.join(temp, 'profile'));
    let win, server;
    const deadline = setTimeout(() => app.exit(1), 25000);
    try {
      await app.whenReady();
      const { installNativeTrackpad } = require(path.join(temp, 'input.cjs'));
      const addon = require(path.join(desktop, 'resources/tools/trackpad/cindy-trackpad.node'));
      assert.equal(typeof addon.start, 'function');
      assert.equal(typeof addon.position, 'function');
      assert.equal(typeof addon.stop, 'function');
      addon.stop(0); // Unbound/stale capture cleanup must also be callable.
      if (process.argv[3]) {
        const url = fs.readFileSync(process.argv[3], 'utf8').trim(),
          parsed = new URL(url);
        assert.equal(parsed.protocol, 'http:');
        assert(['127.0.0.1', 'localhost'].includes(parsed.hostname));
        const exercise = process.env.CINDY_TRACKPAD_EXERCISE === '1';
        if (!exercise) clearTimeout(deadline);
        let exercisePoint, exerciseInput;
        win = new BrowserWindow({
          width: 900,
          height: 1000,
          title: '设备模拟器 · 原生双指测试',
          webPreferences: { sandbox: true, contextIsolation: true },
        });
        const inputTrace = [];
        if (exercise) {
          const command = win.webContents.debugger.sendCommand.bind(win.webContents.debugger);
          win.webContents.debugger.sendCommand = async (method, ...args) => {
            try {
              const r = await command(method, ...args);
              inputTrace.push({
                method,
                node: r.node?.nodeName,
                box: r.model?.content,
                value: r.result?.value,
                object: !!r.result?.objectId,
              });
              return r;
            } catch (error) {
              inputTrace.push({ method, error: String(error) });
              throw error;
            }
          };
          win.webContents.on('before-mouse-event', (_e, input) =>
            inputTrace.push({ input: input.type }),
          );
          win.webContents.on('did-start-navigation', (_e, _url, inPlace, main) =>
            inputTrace.push({ inPlace, main }),
          );
        }
        installNativeTrackpad(win.webContents, win.webContents, () => true, {
          platform: process.platform,
          window: () => win,
          load: () => ({
            position: (handle) => (exercise ? exercisePoint : addon.position(handle)),
            stop: (id) => {
              if (!exercise) addon.stop(id);
            },
            start: (handle, callback) => {
              if (exercise) {
                exerciseInput = callback;
                return 1;
              }
              const id = addon.start(handle, (packet) => {
                const p = JSON.parse(packet);
                if (p.phase === 'begin') console.log('NATIVE_CONTACTS_BEGIN');
                callback(packet);
              });
              if (id !== null) console.log('NATIVE_CAPTURE_READY');
              return id;
            },
          }),
        });
        win.on('page-title-updated', (event) => event.preventDefault());
        app.on('window-all-closed', () => app.quit());
        await win.loadURL(url);
        win.setTitle('设备模拟器 · 原生双指测试');
        win.show();
        app.focus({ steal: true });
        win.focus();
        console.log('NATIVE_PREVIEW_READY');
        if (exercise) {
          // Explicit runtime tier: replay contacts through the actual viewer
          // and its WebSocket/device transport; never presented as hardware input.
          const find = async (frame, offset = { x: 0, y: 0 }) => {
            const r = await frame.executeJavaScript(
              `(()=>{const e=document.querySelector('[data-cindy-trackpad="contacts"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`,
            );
            if (r?.width > 0)
              return {
                frame,
                x: offset.x + r.x,
                y: offset.y + r.y,
                width: r.width,
                height: r.height,
              };
            for (const child of frame.frames) {
              const bounds = await frame.executeJavaScript(
                `(()=>{const e=[...document.querySelectorAll('iframe')].find(e=>e.src===${JSON.stringify(child.url)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y};})()`,
              );
              if (bounds) {
                const found = await find(child, { x: offset.x + bounds.x, y: offset.y + bounds.y });
                if (found) return found;
              }
            }
          };
          let target;
          for (let i = 0; i < 100 && !target; i++) {
            target = await find(win.webContents.mainFrame);
            if (!target) await new Promise((r) => setTimeout(r, 50));
          }
          assert(target, 'Live contact surface missing');
          await target.frame.executeJavaScript(
            `window.__inputProbe={sent:[],painted:0,received:0,decoded:0,raf:0};const tick=()=>{__inputProbe.raf++;requestAnimationFrame(tick)};requestAnimationFrame(tick);if(window.VideoDecoder){const decode=VideoDecoder.prototype.decode;VideoDecoder.prototype.decode=function(...args){__inputProbe.decoded++;return decode.apply(this,args);};}const originalSend=WebSocket.prototype.send;WebSocket.prototype.send=function(data){if(!this.__probed){this.__probed=true;this.addEventListener('message',e=>{if(e.data instanceof ArrayBuffer)__inputProbe.received++;});}try{const p=JSON.parse(data);if(p.type?.startsWith('touch'))__inputProbe.sent.push({at:Date.now(),...p});}catch{}return originalSend.call(this,data);};const originalDraw=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(...args){__inputProbe.painted++;return originalDraw.apply(this,args);};`,
          );
          for (let i = 0; i < 200; i++) {
            if (await target.frame.executeJavaScript('__inputProbe.painted>=3')) break;
            await new Promise((r) => setTimeout(r, 25));
          }
          target = await find(win.webContents.mainFrame);
          assert(target, 'Live surface disappeared');
          exercisePoint = { x: target.x + target.width * 0.5, y: target.y + target.height * 0.3 };
          for (let i = 0; i < 100 && !exerciseInput; i++) {
            if (!win.isFocused()) app.focus({ steal: true });
            win.focus();
            win.webContents.focus();
            win.webContents.sendInputEvent({ type: 'mouseMove', ...exercisePoint });
            await new Promise((r) => setTimeout(r, 10));
          }
          if (!exerciseInput) {
            fs.writeFileSync(
              '/tmp/cindy-trackpad-arm-failure.png',
              (await win.webContents.capturePage()).toPNG(),
            );
            console.log(
              'ARM_FAILURE',
              JSON.stringify({
                focus: win.isFocused(),
                guestFocus: win.webContents.isFocused(),
                point: exercisePoint,
                meta: await win.webContents.executeJavaScript(
                  'document.querySelector("meta[name=cindy-native-trackpad]")?.content',
                ),
                trace: inputTrace.slice(-18),
              }),
            );
          }
          assert(exerciseInput, 'Live input not armed');
          const emit = (phase, span) =>
            exerciseInput(
              JSON.stringify({
                phase,
                width: 100,
                height: 70,
                touches:
                  phase === 'end'
                    ? []
                    : [
                        { id: 0, x: 0.5 - span, y: 0.5 },
                        { id: 1, x: 0.5 + span, y: 0.5 },
                      ],
              }),
            );
          // capturePage immediately before playback perturbs video cadence on
          // macOS (21 vs 104 painted frames in the same ~2 s replay). Capture
          // evidence only after measuring so the observer does not become the
          // apparent input/stream bottleneck.
          await target.frame.executeJavaScript(
            '__inputProbe.painted=__inputProbe.decoded=__inputProbe.received=__inputProbe.raf=0',
          );
          const started = Date.now();
          emit('begin', 0.12);
          for (let i = 0; i < 100; i++) {
            emit('change', 0.12 + i * 0.0018);
            await new Promise((r) => setTimeout(r, 8));
          }
          for (let i = 98; i >= 0; i--) {
            emit('change', 0.12 + i * 0.0018);
            await new Promise((r) => setTimeout(r, 8));
          }
          emit('end', 0);
          await new Promise((r) => setTimeout(r, 250));
          const probe = await target.frame.executeJavaScript('__inputProbe');
          console.log(
            'LIVE_INPUT',
            JSON.stringify({
              elapsed: Date.now() - started,
              frames: probe.painted,
              received: probe.received,
              decoded: probe.decoded,
              raf: probe.raf,
              types: probe.sent.reduce((a, p) => ((a[p.type] = (a[p.type] || 0) + 1), a), {}),
              first: probe.sent[0],
              last: probe.sent.at(-1),
            }),
          );
          assert.equal(probe.sent[0]?.type, 'touch2-down');
          assert.equal(probe.sent.at(-1)?.type, 'touch2-up');
          assert(!probe.sent.some((p) => p.type.startsWith('touch1')));
          assert.equal(
            probe.sent.length,
            201,
            'Replay interrupted (focus/navigation) or mixed with another input source',
          );
          assert(probe.painted >= 70, 'Full viewer video cadence is still low');
          fs.writeFileSync(
            '/tmp/cindy-trackpad-live-after.png',
            (await win.webContents.capturePage()).toPNG(),
          );
          win.destroy();
          clearTimeout(deadline);
          app.exit(0);
        }
        return;
      }
      server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html');
        const port = server.address().port;
        if (req.url === '/outer')
          res.end(
            `<meta name="cindy-native-trackpad" content="touch"><iframe style="position:absolute;left:40px;top:60px;width:500px;height:600px;border:0" src="http://127.0.0.1:${port}/middle"></iframe>`,
          );
        else if (req.url === '/middle')
          res.end(
            '<iframe style="position:absolute;left:10px;top:10px;width:480px;height:580px;border:0" src="/screen"></iframe>',
          );
        else
          res.end(`<style>body{margin:0}canvas{position:absolute;left:20px;top:10px;width:400px;height:500px;touch-action:none}</style><canvas data-cindy-trackpad="${process.env.CINDY_TRACKPAD_VERIFY_CONTACTS === '1' ? 'contacts' : ''}"></canvas><script>
        window.events=[];for(const type of ['touchstart','touchmove','touchend','touchcancel'])document.querySelector('canvas').addEventListener(type,e=>{e.preventDefault();events.push({type,at:Date.now(),touches:[...e.touches].map(t=>({id:t.identifier,x:t.clientX,y:t.clientY}))});},{passive:false});
        let count=0;document.querySelector('canvas').addEventListener('cindy-trackpad',e=>{
          const f=e.detail,type=f.phase==='begin'?'touchstart':f.phase==='cancel'?'touchcancel':f.phase==='end'||f.touches.length<count?'touchend':'touchmove';
          count=f.touches.length;events.push({type,at:Date.now(),touches:f.touches});
        });
      </script>`);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      win = new BrowserWindow({
        width: 700,
        height: 800,
        webPreferences: { sandbox: true, contextIsolation: true },
      });
      const wc = win.webContents;
      const command = wc.debugger.sendCommand.bind(wc.debugger);
      wc.debugger.sendCommand = async (method, ...args) => {
        try {
          const result = await command(method, ...args);
          if (method === 'Input.dispatchTouchEvent' || method === 'DOM.getBoxModel')
            console.log(method, JSON.stringify(args), JSON.stringify(result));
          return result;
        } catch (error) {
          console.error('CDP', method, error);
          throw error;
        }
      };
      let callback, armed;
      const ready = new Promise((r) => (armed = r));
      installNativeTrackpad(wc, wc, () => true, {
        platform: 'darwin',
        load: () => ({
          position: () => ({ x: 270, y: 330 }),
          start: (_handle, cb) => {
            console.log('capture armed');
            callback = cb;
            armed();
            return 1;
          },
          stop: () => {},
        }),
        window: () => win,
      });
      await win.loadURL(`http://localhost:${server.address().port}/outer`);
      await wc.capturePage(); // Wait for the nested frame's first compositor frame.
      win.show();
      win.focus();
      wc.focus();
      for (let i = 0; i < 100 && !callback; i++) {
        win.focus();
        wc.focus();
        wc.sendInputEvent({ type: 'mouseMove', x: 270, y: 330 });
        await new Promise((r) => setTimeout(r, 10));
      }
      assert(callback, 'Native surface not armed after focus/DOM readiness');
      await ready;
      const frame = wc.mainFrame.frames[0].frames[0];
      const points = [
        { id: 0, x: 0.3, y: 0.5 },
        { id: 1, x: 0.7, y: 0.5 },
      ];
      const emit = (phase, touches) => {
        console.log('emit', phase);
        callback(JSON.stringify({ phase, touches, width: 100, height: 70 }));
      };
      const until = async (predicate) => {
        for (let i = 0; i < 100; i++) {
          const events = await frame.executeJavaScript('events');
          if (predicate(events)) return events;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw Error(`Touch delivery did not settle; focused=${wc.isFocused()}/${win.isFocused()}`);
      };
      emit('begin', points);
      await until((e) => e.some((v) => v.type === 'touchstart' && v.touches.length === 2));
      emit('change', [points[0], { id: 1, x: 0.8, y: 0.6 }]);
      const events = await until((e) => e.some((v) => v.type === 'touchmove'));
      const start = events.find((v) => v.touches.length === 2).touches;
      const moved = events.findLast((v) => v.type === 'touchmove').touches;
      assert.deepEqual(moved[0], start[0]);
      assert.equal(Math.round(moved[1].x - start[1].x), 50);
      assert.equal(Math.round(moved[1].y - start[1].y), 35);
      // Runtime tier: measure sustained input, not just eventual correctness.
      // Each position identifies its sample across the real renderer boundary.
      const sent = new Map();
      for (let i = 0; i < 120; i++) {
        const x = 0.55 + i / 1000;
        sent.set(Math.round((start[1].x + (x - 0.7) * 500) * 10), Date.now());
        emit('change', [points[0], { id: 1, x, y: 0.5 }]);
        await new Promise((r) => setTimeout(r, 8));
      }
      const measured = await until((e) =>
        e.some(
          (v) => v.type === 'touchmove' && Math.abs(v.touches[1]?.x - (start[1].x - 15.5)) < 0.1,
        ),
      );
      const latency = measured
        .filter((v) => v.type === 'touchmove' && v.touches.length === 2)
        .map((v) =>
          sent.has(Math.round(v.touches[1].x * 10))
            ? v.at - sent.get(Math.round(v.touches[1].x * 10))
            : null,
        )
        .filter((v) => v !== null)
        .sort((a, b) => a - b);
      console.log(
        'INPUT_METRICS',
        JSON.stringify({
          sent: 120,
          received: latency.length,
          p50: latency[Math.floor(latency.length * 0.5)],
          p95: latency[Math.floor(latency.length * 0.95)],
          max: latency.at(-1),
          initialContacts: measured
            .filter((v) => v.type === 'touchstart')
            .map((v) => v.touches.length),
        }),
      );
      if (process.env.CINDY_TRACKPAD_VERIFY_CONTACTS === '1') {
        assert.deepEqual(
          measured.filter((v) => v.type === 'touchstart').map((v) => v.touches.length),
          [2],
        );
        assert.equal(latency.length, 120);
      }
      emit('change', [points[0]]);
      await until((e) => e.some((v) => v.type === 'touchend' && v.touches.length === 1));
      emit('end', []);
      await until((e) => e.some((v) => v.type === 'touchend' && v.touches.length === 0));
      emit('begin', points);
      await until(
        (e) => e.filter((v) => v.type === 'touchstart' && v.touches.length === 2).length === 2,
      );
      win.emit('blur');
      await until((e) => e.some((v) => v.type === 'touchcancel'));
      console.log(
        'PASS: native addon loads; nested iframe mapping, stationary finger, independent motion, liftoff and blur cancellation',
      );
      win.destroy();
      server.close();
      clearTimeout(deadline);
      app.exit(0);
    } catch (error) {
      console.error(error);
      win?.destroy();
      server?.close();
      clearTimeout(deadline);
      app.exit(1);
    }
  })();
}
