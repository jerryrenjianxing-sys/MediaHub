'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

class HyperframesClient extends EventEmitter {
  constructor({ helperPath, log }) {
    super(); this.helperPath = helperPath; this.log = log || (() => {});
    this.child = null; this.root = null; this.sequence = 0; this.pending = new Map(); this.tasks = new Map(); this.finished = new Map(); this.active = new Set(); this.starting = null;
  }
  async start(root) {
    if (this.starting) { await this.starting; return this.start(root); }
    this.starting = this.startInternal(root);
    try { return await this.starting; } finally { this.starting = null; }
  }
  async startInternal(root) {
    root = fs.realpathSync(root);
    if (this.child && this.root === root) return this.request('status', {});
    await this.stop();
    const node = path.join(root, 'runtime/node/node.exe');
    const entry = path.join(root, 'service-entry.mjs');
    for (const file of [node, entry, this.helperPath]) if (!fs.existsSync(file)) throw new Error(`工具包文件缺失：${path.basename(file)}`);
    this.root = root;
    // The trusted helper owns a kill-on-close Job Object containing Node, Chromium and FFmpeg.
    const child = spawn(this.helperPath, ['job', '--', node, entry], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' }
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', line => {
      if (Buffer.byteLength(line) > 1024 * 1024) { this.log('hyperframes', 'Oversized response rejected'); return; }
      let message; try { message = JSON.parse(line); } catch { this.log('hyperframes', 'Non-protocol output omitted'); return; }
      if (!message.event && message.id !== undefined) {
        const pending = this.pending.get(String(message.id));
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(String(message.id));
        if (message.error) pending.reject(Object.assign(new Error(message.error.message || '工具调用失败'), { code: message.error.code }));
        else pending.resolve(message.result);
      } else if (message.event === 'progress') {
        const task = this.tasks.get(message.taskId);
        task?.context?.progress?.({ phase: message.stage || 'rendering', percent: Number(message.progress) || 0, message: message.message || '正在渲染' });
        this.emit('progress', message);
      } else if (message.event === 'task') {
        message.status = { complete: 'completed', rendering: 'running', validating: 'running' }[message.status] || message.status;
        if (['queued', 'running', 'cancelling'].includes(message.status)) this.active.add(message.taskId);
        const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(message.status || message.state);
        if (terminal) {
          this.active.delete(message.taskId);
          this.finished.set(message.taskId, message);
          const task = this.tasks.get(message.taskId);
          if (task) { this.tasks.delete(message.taskId); task.resolve(message); }
        }
        // Host listeners can synchronously decide whether all work has finished.
        this.emit('task', message);
      }
    });
    child.stderr.on('data', data => this.log('hyperframes', String(data).slice(0, 4000)));
    child.on('error', error => { if (this.child !== child) return; this.child = null; this.root = null; this.failAll(error); this.emit('stopped', { error: error.message }); });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null; this.root = null;
      this.failAll(new Error(`HyperFrames 服务已停止 (${code ?? signal})`)); this.emit('stopped', { code, signal });
    });
    return this.request('status', {}, 45000);
  }
  failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const task of this.tasks.values()) task.reject(error);
    this.tasks.clear();
    this.active.clear();
  }
  request(method, params = {}, timeout = 60000) {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error('HyperFrames 服务尚未启动'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`HyperFrames ${method} 超时，结果未知；请查询任务状态`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async invoke(action, params, context) {
    if (action === 'stop') { await this.stop(); return { stopped: true }; }
    if (action !== 'render') return this.request(action, params, action === 'check' ? 180000 : 60000);
    const taskId = context.taskId || params.taskId;
    if (!taskId) throw new Error('渲染必须带有平台任务 ID');
    if (context.signal?.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });
    const result = this.waitTask(taskId, context);
    this.active.add(taskId);
    result.catch(() => {});
    const cancel = () => { this.request('cancel', { taskId }, 180000).catch(error => this.log('cancel', error.message)); };
    context.signal?.addEventListener('abort', cancel, { once: true });
    try {
      try { await this.request('render', { ...params, taskId }, 60000); }
      catch (error) {
        if (error.code) { this.active.delete(taskId); throw error; }
        // A transport timeout does not prove that a render was rejected. Query, never replay.
        const status = await this.request('status', { taskId }, 30000).catch(() => null);
        if (['complete', 'completed', 'failed', 'cancelled'].includes(status?.status)) {
          status.status = status.status === 'complete' ? 'completed' : status.status;
          this.active.delete(taskId); this.tasks.get(taskId)?.resolve(status); this.tasks.delete(taskId);
        } else if (status && !['queued', 'rendering', 'validating', 'running'].includes(status.status)) { this.active.delete(taskId); throw error; }
        else if (!status) context.progress?.({ phase: 'unknown', message: '受理结果未知，正在等待真实回执；可以取消任务' });
      }
      // An abort may have arrived before the sidecar created its task record.
      if (context.signal?.aborted) await this.request('cancel', { taskId }, 180000);
      const receipt = await result;
      const state = receipt.status || receipt.state;
      if (state === 'cancelled') throw Object.assign(new Error('渲染已取消，进程已停止'), { name: 'AbortError', code: 'CANCELLED' });
      if (state !== 'completed') throw new Error(receipt.error?.message || receipt.error || '渲染失败');
      return receipt;
    } finally { context.signal?.removeEventListener('abort', cancel); if (!this.active.has(taskId)) this.tasks.delete(taskId); }
  }
  waitTask(taskId, context = {}) {
    if (this.finished.has(taskId)) return Promise.resolve(this.finished.get(taskId));
    return new Promise((resolve, reject) => { this.tasks.set(taskId, { resolve, reject, context }); });
  }
  async stop({ idleOnly = false } = {}) {
    const child = this.child;
    if (!child) return;
    try { await this.request('shutdown', { idleOnly }, 180000); } catch (error) { if (idleOnly) throw error; this.log('shutdown', error.message); }
    if (child.exitCode === null) {
      await new Promise((resolve, reject) => {
        const killTimer = setTimeout(() => child.kill(), 5000);
        const timeout = setTimeout(() => reject(new Error('未能确认 HyperFrames 进程组停止')), 20000);
        child.once('exit', () => { clearTimeout(killTimer); clearTimeout(timeout); resolve(); });
      });
    }
    this.child = null; this.root = null;
  }
  async cancelActive() { for (const taskId of [...this.active]) await this.request('cancel', { taskId }, 180000); }
  get busy() { return this.active.size > 0; }
}
module.exports = { HyperframesClient };
