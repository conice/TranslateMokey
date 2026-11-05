import { boundedText, language } from './core.js';

export function createSpeech(window) {
  let active;
  function stop() {
    if (active) window.speechSynthesis.cancel();
    active = undefined;
  }
  return {
    stop,
    speak(text, code, report = () => {}) {
      const input = boundedText(text, '发音文本', 200);
      const lang = language(code);
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) throw new Error('浏览器不支持语音合成');
      const voices = window.speechSynthesis.getVoices().filter((voice) => voice.localService === true);
      const voice = voices.find((item) => item.lang.toLowerCase() === lang)
        ?? voices.find((item) => item.lang.toLowerCase().split('-')[0] === lang.split('-')[0]);
      if (!voice) throw new Error('没有此语言的本地语音；请在系统安装语音包，或稍后重试。不会自动改用联网语音。');
      stop();
      const utterance = new window.SpeechSynthesisUtterance(input);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.onend = () => { if (active === utterance) { active = undefined; report('发音结束'); } };
      utterance.onerror = () => { if (active === utterance) { active = undefined; report('发音失败，请检查系统语音服务'); } };
      active = utterance;
      try { window.speechSynthesis.speak(utterance); }
      catch { active = undefined; throw new Error('无法启动系统发音'); }
      report(`本地发音：${voice.name}（${voice.lang}）`);
    },
  };
}
