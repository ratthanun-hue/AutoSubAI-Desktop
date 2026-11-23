(() => {
  'use strict';

  const STORAGE_KEY = 'autosub_desktop_series_glossaries';

  const DEFAULT_GLOSSARIES = {
    'ซีรีส์จีนย้อนยุค (Default)': [
      { wrong: 'ท่านออง', right: 'ท่านอ๋อง' },
      { wrong: 'ฮองเฮ่า', right: 'ฮองเฮา' },
      { wrong: 'พะย่ะค่ะ', right: 'พ่ะย่ะค่ะ' },
      { wrong: 'นะค่ะ', right: 'นะคะ' },
    ],
    'ละครไทยทั่วไป': [
      { wrong: 'นะค่ะ', right: 'นะคะ' },
      { wrong: 'อนุญาตินะ', right: 'อนุญาตนะ' },
      { wrong: 'ออแกไนซ์', right: 'ออร์แกไนซ์' },
    ],
  };

  class DesktopGlossaryManager {
    constructor() {
      this.glossaries = this._load();
      this.activeSeries = Object.keys(this.glossaries)[0] || 'Default';
    }

    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            return parsed;
          }
        }
      } catch (_) {}
      return JSON.parse(JSON.stringify(DEFAULT_GLOSSARIES));
    }

    _save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.glossaries));
      } catch (_) {}
    }

    listSeries() {
      return Object.keys(this.glossaries);
    }

    getRules(seriesName = this.activeSeries) {
      return this.glossaries[seriesName] || [];
    }

    setActiveSeries(name) {
      if (this.glossaries[name]) this.activeSeries = name;
    }

    createSeries(name) {
      const clean = String(name || '').trim();
      if (!clean) return false;
      if (!this.glossaries[clean]) {
        this.glossaries[clean] = [];
      }
      this.activeSeries = clean;
      this._save();
      return true;
    }

    deleteSeries(name) {
      const keys = Object.keys(this.glossaries);
      if (keys.length <= 1) return false;
      delete this.glossaries[name];
      this.activeSeries = Object.keys(this.glossaries)[0];
      this._save();
      return true;
    }

    addRule(wrong, right) {
      const w = String(wrong || '').trim();
      const r = String(right || '').trim();
      if (!w || !r) return false;
      if (!this.glossaries[this.activeSeries]) this.glossaries[this.activeSeries] = [];
      this.glossaries[this.activeSeries].push({ wrong: w, right: r });
      this._save();
      return true;
    }

    removeRule(idx) {
      const rules = this.glossaries[this.activeSeries];
      if (!rules || idx < 0 || idx >= rules.length) return;
      rules.splice(idx, 1);
      this._save();
    }

    applyToSegments(segments) {
      const rules = this.getRules();
      let replacements = 0;
      for (const seg of segments) {
        for (const rule of rules) {
          if (rule.wrong && seg.text && seg.text.includes(rule.wrong)) {
            const parts = seg.text.split(rule.wrong);
            replacements += parts.length - 1;
            seg.text = parts.join(rule.right);
          }
        }
      }
      return replacements;
    }

    exportJson() {
      return JSON.stringify({
        series: this.activeSeries,
        rules: this.getRules(),
      }, null, 2);
    }

    importJson(rawText) {
      const parsed = JSON.parse(rawText);
      const name = String(parsed.series || 'Imported Series').trim();
      const rules = Array.isArray(parsed.rules) ? parsed.rules.filter((r) => r && r.wrong && r.right) : [];
      this.glossaries[name] = rules;
      this.activeSeries = name;
      this._save();
      return { series: name, count: rules.length };
    }
  }

  window.DesktopGlossaryManager = DesktopGlossaryManager;
})();
