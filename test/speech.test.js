import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeech } from '../src/speech.js';

test('发音只选匹配语言的本地语音，替换和停止会取消当前播放', () => {
  const spoken = [];
  let stops = 0;
  const local = { name: 'Local', lang: 'en-US', localService: true };
  const window = { SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, speechSynthesis: {
    getVoices: () => [{ name: 'Remote', lang: 'en-US', localService: false }, local], speak: (item) => spoken.push(item), cancel() { stops += 1; },
  } };
  const speech = createSpeech(window);
  speech.stop();
  assert.equal(stops, 0);
  speech.speak('hello', 'en-US');
  assert.equal(spoken[0].voice, local);
  assert.equal(spoken[0].text, 'hello');
  speech.speak('world', 'en-GB');
  assert.equal(stops, 1);
  speech.stop();
  assert.equal(stops, 2);
  assert.throws(() => speech.speak('词', 'zh-CN'), /本地语音/);
  assert.throws(() => speech.speak('word', 'auto'), /语言/);
  assert.throws(() => speech.speak('a'.repeat(201), 'en'), /200/);
});

test('缺失 API 或仅远端语音时明确失败，不自动联网', () => {
  assert.throws(() => createSpeech({}).speak('hello', 'en'), /不支持/);
  const speech = createSpeech({ SpeechSynthesisUtterance: class {}, speechSynthesis: {
    getVoices: () => [{ lang: 'en', localService: false }], speak() { assert.fail('不得播放'); },
  } });
  assert.throws(() => speech.speak('hello', 'en'), /本地语音/);
});
