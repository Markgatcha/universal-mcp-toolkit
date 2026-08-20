# universal-mcp-toolkit

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <b>हिन्दी</b> · <a href="README.ar.md">العربية</a>
</p>

**प्रोडक्शन-रेडी MCP सर्वर्स कें लिये कैनोनिकल ओपन-सोरस मोनोरिपो।**

GitHub, Slack, Notion, डेटाबेस, क्लाउड प्लेटफ़ॉर्र्म, रिसर्च स्रोतों और लोकल फ़ाइलों कें लिये बढ़िया MCP सर्वर एक ही जगह पर — आधे-अधूरे रिपो की दर्जन भर टुकड़ों को जोड़े बिना।

## ⚡ क्विक स्टार्ट

```bash
# सभी 28 उपलब्ध सर्वर देखें
npx universal-mcp-toolkit list

# इंटरैक्टिव सेटअप — सर्वर चुनें, ट्रांसपोर्ट चुनें, कॉन्फ़िग लिखें
npx universal-mcp-toolkit install

# Claude Desktop कें लिये कॉन्फ़िग स्निपेट बनाएं
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# सर्वर को लोकली चलाएं
npx universal-mcp-toolkit run github --transport stdio

# डीबग करनें सें पहलें अपनें एनवायरनमेंट की जांच करेें
npx universal-mcp-toolkit doctor github
```

या ग्लोबली इंस्टॉल करें:

```bash
npm install -g universal-mcp-toolkit
umt list
```

## यह क्योें है

MCP इकोसिस्टम में विस्फोट हो रहा है, लेकिन डेवलपर अनुभव अभी भी बिखरा हुआ है:

- ज़्यादातर रिपो सिर्फ एक संकीर्ण इंटीग्रेशन हल करते हैं
- कई सर्वर डेमो-क्वालिटी के एक-दो टूल्स पर रुक जाते हैं
- ट्रांसपोर्ट सपोर्ट, ऑथ हैंडलिंग, डॉक्स और पैकेजिंग असंगत हैं

`universal-mcp-toolkit` इसे एक उच्च-गुणवत्ता वाले Turborepo से ठीक करता है:

- **28 प्रोडक्शन-फोकस्ड MCP सर्वर**
- एक साझा स्ट्रिक्ट-मोड TypeScript कोर
- एक परिष्कृत CLI: इंस्टॉल, कॉन्फ़िगर, रन और डायग्नोस्टिक्स
- सुसंगत Zod वैलिडेशन, स्ट्रक्चर्ड एरर और pino लॉगिंग
- तीन ट्रांसपोर्ट: stdio, SSE और MCP 2026-07-28 स्ट्रीमेबल HTTP

## 🌐 AI Trio

UMT तीन सहयोगी प्रोजेक्ट्स में से एक है जो साथ में काम करते हैं:

| प्रोजेक्ट | भूमिका |
|-----------|--------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCP प्रोटोकॉल, सर्वर रजिस्ट्री और टूल रूटिंग |
| [memos](https://github.com/Markgatcha/memos) | सेशनों के बीच ग्राफ़-आधारित स्थायी मेमोरी |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | टोकन-लागत रक्षक: प्रॉम्प्ट सिकोड़ता है और मेमोरी जोड़ता है |

MemOS MCP एडॉप्टर `@mem-os/sdk` के रूप में प्रकाशित होता है और UMT के `link memos` कमांड के साथ सीधे जुड़ता है।

## 🌐 समुदाय

- वेबसाइट: https://context-core.dev/umt/
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ स्टार इतिहास

अगर UMT आपको आधे-अधूरे MCP रिपो जोड़ने से बचाता है, तो एक स्टार दें — इससे प्रोजेक्ट दिखाई देता रहता है।

<p align="center">
  <a href="https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## लाइसेंस

MIT — पूरी शर्तों के लिए [LICENSE](../LICENSE) देखें।
