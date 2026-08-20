<div dir="rtl">

# universal-mcp-toolkit

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <b>العربية</b>
</p>

**المستودع الأحادي (monorepo) مفتوح المصدر المعتمد لخوادم MCP الجاهزة للإنتاج.**

مكان واحد للعثور على خوادم MCP ممتازة لـ GitHub وSlack وNotion وقواعد البيانات ومنصات السحابة ومصادر البحث والملفات المحلية — دون تجميع عشرات المستودعات غير المكتملة.

## ⚡ البدء السريع

```bash
# عرض جميع الخوادم الـ 28 المتاحة
npx universal-mcp-toolkit list

# تثبيت تفاعلي — اختر الخوادم والنقل واكتب الإعدادات
npx universal-mcp-toolkit install

# توليد مقطع إعدادات لـ Claude Desktop
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# تشغيل خادم محليا
npx universal-mcp-toolkit run github --transport stdio

# فحص بيئتك قبل التنقيح
npx universal-mcp-toolkit doctor github
```

أو ثبّته عالمياً:

```bash
npm install -g universal-mcp-toolkit
umt list
```

## لماذا يوجد هذا المشروع

منظومة MCP تنفجر نمواً، لكن تجربة المطور لا تزال مجزأة:

- معظم المستودعات تحل تكاملاً ضيقاً واحداً
- كثير من الخوادم تتوقف عند أداة أو اثنتين بجودة تجريبية
- دعم النقل ومعالجة المصادقة والتوثيق والتغليف غير متسقة

يصلح `universal-mcp-toolkit` ذلك عبر Turborepo واحد عالي الجودة:

- **28 خادم MCP موجهاً للإنتاج**
- نواة TypeScript مشتركة واحدة بالوضع الصارم
- CLI مصقول: تثبيت، إعداد، تشغيل، وتشخيص
- تحقق Zod متسق، وأخطاء مهيكلة، وتسجيل pino
- ثلاثة أنماط نقل: stdio وSSE وHTTP قابل للبث MCP 2026-07-28

## 🌐 ثلاثي الذكاء الاصطناعي (AI Trio)

UMT واحد من ثلاثة مشاريع شقيقة تتكامل معا:

| المشروع | الدور |
|---------|-------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | بروتوكول MCP وسجل الخوادم وتوجيه الأدوات |
| [memos](https://github.com/Markgatcha/memos) | ذاكرة دائمة قائمة على الرسم البياني عبر الجلسات |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | حارس تكلفة الرموز: يضغط الموجّهات ويحقن الذاكرة |

يُنشر محوّل MemOS MCP باسم `@mem-os/sdk` ويتكامل مباشرة مع أمر UMT ‏`link memos`.

## 🌐 المجتمع

- الموقع: https://context-core.dev/umt/
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ سجل النجوم

إذا كان UMT يوفر عليك تجميع عشرات مستودعات MCP غير المكتملة، ففكّر في النجمة — فهي تُبقي المشروع مرئياً.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## الترخيص

MIT — راجع [LICENSE](../LICENSE) للشروط الكاملة.

</div>
