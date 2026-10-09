# moa-lite 출처와 라이선스

MOA UI·카탈로그·작품 묶기·시즌·TMDB·인증·자막·번역 코드는 [sidetool/moa](https://github.com/sidetool/moa), 커밋 `a7ff835e76b9769432f00dcadaad788993464c92`에서 가져왔다. 원본 Git 이력과 [GPL-3.0 라이선스](LICENSE)를 유지한다. moa-lite의 추가 코드는 GPL-3.0-or-later이다.

React, hls.js, JASSUB, sql.js, QuickJS/WASM, linkedom, noble, buffer 등 기존/추가 의존성은 각 패키지의 라이선스를 따른다. Worker 배포 의존성의 라이선스 전문은 빌드 시 `/runtime/THIRD_PARTY_LICENSES.txt`에 함께 배포한다. TMDB의 기존 공식 이미지와 크레딧을 유지한다.

---

# Third-party notices

MOA-authored code is GPL-3.0-or-later. Reused code and dependencies retain their original licenses; the root grant does not relicense them, external data, or user-installed extensions. License texts and original copyright notices are under [LICENSES](LICENSES/). This inventory describes the pinned dependency snapshot; it is not a claim that every future platform or binary is cleared for redistribution.

The QuickJS host, source compatibility modules, outbound proxy and MOA worker/browser
implementation are MOA-authored code under GPL-3.0-or-later. Third-party runtimes
and build-selected upstream files keep the licenses listed below.

## Copied code and build-selected sources

| Component / origin | Scope and license |
| --- | --- |
| [Suwayomi Server v2.3.2243](https://github.com/Suwayomi/Suwayomi-Server/tree/v2.3.2243) | SHA-256 `e70f664013e83d49fee66ab5f83b6f281d956560c5a8baeba1d00b417048efb2`. Selected Android preference files, MemoryCookieJar and RxCoroutineBridge are MPL-2.0; JsonObject is conservatively treated as MPL-2.0 (no per-file header). Preference/ListPreference/TwoStatePreference are modified by `build.py`. |
| Android Open Source Project / Apache Software Foundation | Suwayomi-selected NonNull/Nullable (2013), Uri (2007), LruCache (2011), UriCodec: Apache-2.0, original headers preserved. Uri is modified to remove emulated-storage remapping. UriCodec references an ASF NOTICE; its exact corresponding original NOTICE is **UNKNOWN**. |
| Tachiyomi-derived Suwayomi helpers | HttpException, OkHttpExtensions, ProgressListener, ProgressResponseBody, Requests and JsoupExtensions fall under the nested Apache-2.0 notice, Copyright 2015 Javier Tomás. Individual files lack headers; owner must confirm the scope. MemoryCookieJar's explicit MPL header takes precedence. Requests gains JVM facade annotations. [Original nested notice](LICENSES/Tachiyomi-Apache-2.0.txt). |
| [Aniyomi](https://github.com/aniyomiorg/aniyomi/tree/97414446b8a95994c72dd33c41c971a89d4d25b8) | Source API commit `97414446b8a95994c72dd33c41c971a89d4d25b8`, SHA-256 `e9bae19c0387b0aa7f977e61ffc35712f0711c7ec877d606bd1bce2ff2193521`. Apache-2.0. Selected API Kotlin sources omit Compose annotations, replace coroutine imports and alias PreferenceScreen; upstream HttpServer is excluded. Original Aniyomi app/APKs are not bundled. |
| MOA ABI shims (`mihon/.../Json.kt`, `RequestsCompat.kt`, `HttpServer.kt`) | Authorship/copy provenance is **UNKNOWN**; namespace alone does not establish a third-party license. Owner must confirm original authorship or record exact source and retained notices. |

## Web/native dependencies, fonts and icons

| Component | Origin / license and distribution notes |
| --- | --- |
| rvfc-polyfill 1.0.8 | [upstream](https://github.com/ThaUnknown/rvfc-polyfill), package declares `GPL-3.0`; conservatively GPL-3.0-only, without inferring later-version permission. Imported by JASSUB. The combined browser distribution must satisfy GPLv3 even though MOA's own code is or-later. |
| JASSUB 2.5.16 | [upstream](https://github.com/ThaUnknown/jassub). JS wrapper MIT; WASM declaration: `LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0`. The wrapper LICENSE is not a license for all WASM components. Exact libass/FreeType/default-font source, notices, build options and relink/replacement material are **UNKNOWN** for a distributable binary; obtain them for the selected artifact. |
| sharp 0.34.5 / libvips prebuilds 1.2.4 | [sharp](https://github.com/lovell/sharp), Apache-2.0; [libvips](https://github.com/libvips/libvips), LGPL-3.0-or-later for the installed prebuilds. Preserve all included library notices, exact source and replacement/relink requirements. Complete prebuilt component notice/source inventory is **UNKNOWN**. |
| Pretendard 1.3.9 | [upstream](https://github.com/orioncactus/pretendard), OFL-1.1, Copyright Kil Hyung-jin, Reserved Font Name Pretendard. Full font license copied from `dist/LICENSE.txt`; do not apply GPL to the font. |
| lucide-react 1.49.0 | [Lucide](https://github.com/lucide-icons/lucide), ISC with Feather-derived MIT notices. Preserve the full copied LICENSE including both copyrights. |
| QuickJS WASM / LinkeDOM | [QuickJS](https://bellard.org/quickjs/) and [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten), MIT wrappers; [LinkeDOM](https://github.com/WebReflection/linkedom), ISC. Preserve original compiler/runtime/WASM copyrights as well as wrapper notices. |
| lightningcss 1.33.0 | [upstream](https://github.com/parcel-bundler/lightningcss), MPL-2.0. Build dependency may remain in the runtime image; preserve its source/notices when redistributed. |
| Patchright 1.61.1 | [upstream](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), Apache-2.0; browser lock also includes socks/smart-buffer/ip-address and optional fsevents (MIT). Chromium has separate component licenses. |
| Container components | Node, nginx, Cloudflare client, OpenJDK/Temurin (GPLv2 with Classpath Exception), Chromium, Debian/Ubuntu/Alpine packages and Nanum fonts retain their own notices. Exact final image versions/component licenses are **UNKNOWN** until the image is built and inventoried. Keep packaged OS copyright files. |
| FFmpeg / Chromaprint | [FFmpeg](https://ffmpeg.org/legal.html) license depends on build options; [Chromaprint](https://github.com/acoustid/chromaprint) LGPL-2.1-or-later. Separate executables do not relicense MOA; verify exact supplied binaries, sources and build flags before publishing images. |

The full npm license files available in the pinned installation are copied under `LICENSES/npm`. A missing full text is marked below; package metadata does not replace the required copyright/license notice. Binary source availability is covered in [THIRD-PARTY-SOURCES](docs/THIRD-PARTY-SOURCES.md).

## npm inventory

| Package | Version | Declared license | Origin | Full notice copied |
| --- | --- | --- | --- | --- |
| `@esbuild/linux-x64` | 0.28.2 | MIT | [upstream](https://github.com/evanw/esbuild#readme) | **UNKNOWN / not found** |
| `@fastify/accept-negotiator` | 2.1.0 | MIT | [upstream](https://github.com/fastify/accept-negotiator#readme) | yes |
| `@fastify/ajv-compiler` | 4.0.6 | MIT | [upstream](https://github.com/fastify/ajv-compiler#readme) | yes |
| `@fastify/error` | 4.2.0 | MIT | [upstream](https://github.com/fastify/fastify-error#readme) | yes |
| `@fastify/fast-json-stringify-compiler` | 5.1.0 | MIT | [upstream](https://github.com/fastify/fast-json-stringify-compiler#readme) | yes |
| `@fastify/forwarded` | 3.0.2 | MIT | [upstream](https://github.com/fastify/forwarded#readme) | yes |
| `@fastify/merge-json-schemas` | 0.2.1 | MIT | [upstream](https://github.com/fastify/merge-json-schemas#readme) | yes |
| `@fastify/proxy-addr` | 5.1.1 | MIT | [upstream](https://github.com/fastify/proxy-addr#readme) | yes |
| `@fastify/send` | 4.1.1 | MIT | [upstream](https://github.com/fastify/send#readme) | yes |
| `@fastify/static` | 8.3.0 | MIT | [upstream](https://github.com/fastify/fastify-static) | yes |
| `@img/colour` | 1.1.0 | MIT | [upstream](https://github.com/lovell/colour#readme) | yes |
| `@img/sharp-libvips-linux-x64` | 1.2.4 | LGPL-3.0-or-later | [upstream](https://sharp.pixelplumbing.com) | **UNKNOWN / not found** |
| `@img/sharp-libvips-linuxmusl-x64` | 1.2.4 | LGPL-3.0-or-later | [upstream](https://sharp.pixelplumbing.com) | **UNKNOWN / not found** |
| `@img/sharp-linux-x64` | 0.34.5 | Apache-2.0 | [upstream](https://sharp.pixelplumbing.com) | yes |
| `@img/sharp-linuxmusl-x64` | 0.34.5 | Apache-2.0 | [upstream](https://sharp.pixelplumbing.com) | yes |
| `@isaacs/cliui` | 9.0.0 | BlueOak-1.0.0 | [upstream](https://github.com/isaacs/cliui#readme) | yes |
| `@jitl/quickjs-ffi-types` | 0.32.0 | MIT | [upstream](https://github.com/justjake/quickjs-emscripten#readme) | yes |
| `@jitl/quickjs-wasmfile-release-sync` | 0.32.0 | MIT | [upstream](https://github.com/justjake/quickjs-emscripten#readme) | yes |
| `@lukeed/ms` | 2.0.2 | MIT | [upstream](https://github.com/lukeed/ms#readme) | yes |
| `@nodable/entities` | 3.1.0 | MIT | [upstream](https://github.com/nodable/val-parsers#readme) | **UNKNOWN / not found** |
| `@oxc-project/types` | 0.152.0 | MIT | [upstream](https://oxc.rs) | yes |
| `@pinojs/redact` | 0.4.0 | MIT | [upstream](https://github.com/pinojs/redact#readme) | yes |
| `@rolldown/binding-linux-x64-gnu` | 1.2.12 | MIT | [upstream](https://rolldown.rs/) | **UNKNOWN / not found** |
| `@rolldown/binding-linux-x64-musl` | 1.2.12 | MIT | [upstream](https://rolldown.rs/) | **UNKNOWN / not found** |
| `@rolldown/pluginutils` | 1.0.1 | MIT | [upstream](https://github.com/rolldown/plugins/tree/main/packages/pluginutils#readme) | yes |
| `@tanstack/query-core` | 5.104.0 | MIT | [upstream](https://tanstack.com/query) | yes |
| `@tanstack/react-query` | 5.104.0 | MIT | [upstream](https://tanstack.com/query) | yes |
| `@types/node` | 22.20.5 | MIT | [upstream](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) | yes |
| `@types/react` | 19.3.0 | MIT | [upstream](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react) | yes |
| `@types/react-dom` | 19.3.0 | MIT | [upstream](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom) | yes |
| `@types/yauzl` | 2.10.3 | MIT | [upstream](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/yauzl) | yes |
| `@typescript/typescript-linux-x64` | 7.0.2 | Apache-2.0 | [upstream](https://www.typescriptlang.org/) | yes |
| `@vitejs/plugin-react` | 6.1.1 | MIT | [upstream](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#readme) | yes |
| `abslink` | 1.3.0 | Apache-2.0 | [upstream](https://github.com/ThaUnknown/abslink#readme) | **UNKNOWN / not found** |
| `abstract-logging` | 2.0.1 | MIT | [upstream](https://github.com/jsumners/abstract-logging#readme) | **UNKNOWN / not found** |
| `agent-base` | 7.1.4 | MIT | [upstream](https://github.com/TooTallNate/proxy-agents#readme) | yes |
| `ajv` | 8.20.0 | MIT | [upstream](https://ajv.js.org) | yes |
| `ajv-formats` | 3.0.1 | MIT | [upstream](https://github.com/ajv-validator/ajv-formats#readme) | yes |
| `anynum` | 1.0.1 | MIT | [upstream](https://github.com/NaturalIntelligence/anynum#readme) | yes |
| `atomic-sleep` | 1.0.0 | MIT | [upstream](https://github.com/davidmarkclements/atomic-sleep#readme) | yes |
| `avvio` | 9.3.0 | MIT | [upstream](https://github.com/fastify/avvio#readme) | yes |
| `balanced-match` | 4.0.4 | MIT | [upstream](https://github.com/juliangruber/balanced-match#readme) | yes |
| `boolbase` | 1.0.0 | ISC | [upstream](https://github.com/fb55/boolbase) | **UNKNOWN / not found** |
| `brace-expansion` | 5.0.12 | MIT | [upstream](https://github.com/juliangruber/brace-expansion#readme) | yes |
| `cheerio` | 1.2.0 | MIT | [upstream](https://cheerio.js.org/) | yes |
| `cheerio-select` | 2.1.0 | BSD-2-Clause | [upstream](https://github.com/cheeriojs/cheerio-select#readme) | yes |
| `content-disposition` | 0.5.4 | MIT | [upstream](https://github.com/jshttp/content-disposition#readme) | yes |
| `cookie` | 1.1.1 | MIT | [upstream](https://github.com/jshttp/cookie#readme) | yes |
| `cross-spawn` | 7.0.6 | MIT | [upstream](https://github.com/moxystudio/node-cross-spawn) | yes |
| `css-select` | 5.2.2 | BSD-2-Clause | [upstream](https://github.com/fb55/css-select#readme) | yes |
| `css-what` | 6.2.2 | BSD-2-Clause | [upstream](https://github.com/fb55/css-what#readme) | yes |
| `cssom` | 0.5.0 | MIT | [upstream](https://github.com/NV/CSSOM#readme) | yes |
| `csstype` | 3.2.3 | MIT | [upstream](https://github.com/frenic/csstype#readme) | yes |
| `debug` | 4.4.3 | MIT | [upstream](https://github.com/debug-js/debug#readme) | yes |
| `depd` | 2.0.0 | MIT | [upstream](https://github.com/dougwilson/nodejs-depd#readme) | yes |
| `dequal` | 2.0.3 | MIT | [upstream](https://github.com/lukeed/dequal#readme) | yes |
| `detect-libc` | 2.1.2 | Apache-2.0 | [upstream](https://github.com/lovell/detect-libc#readme) | yes |
| `dom-serializer` | 2.0.0 | MIT | [upstream](https://github.com/cheeriojs/dom-serializer#readme) | yes |
| `domelementtype` | 2.3.0 | BSD-2-Clause | [upstream](https://github.com/fb55/domelementtype#readme) | yes |
| `domhandler` | 5.0.3 | BSD-2-Clause | [upstream](https://github.com/fb55/domhandler#readme) | yes |
| `domutils` | 3.2.2 | BSD-2-Clause | [upstream](https://github.com/fb55/domutils#readme) | yes |
| `encoding-sniffer` | 0.2.1 | MIT | [upstream](https://github.com/fb55/encoding-sniffer#readme) | yes |
| `entities` | 4.5.0, 6.0.1, 7.0.1 | BSD-2-Clause | [upstream](https://github.com/fb55/entities#readme) | yes |
| `esbuild` | 0.28.2 | MIT | [upstream](https://github.com/evanw/esbuild#readme) | yes |
| `escape-html` | 1.0.3 | MIT | [upstream](https://github.com/component/escape-html#readme) | yes |
| `fast-decode-uri-component` | 1.0.1 | MIT | [upstream](https://github.com/delvedor/fast-decode-uri-component#readme) | yes |
| `fast-deep-equal` | 3.1.3 | MIT | [upstream](https://github.com/epoberezkin/fast-deep-equal#readme) | yes |
| `fast-json-stringify` | 7.0.1 | MIT | [upstream](https://github.com/fastify/fast-json-stringify#readme) | yes |
| `fast-querystring` | 1.1.2 | MIT | [upstream](https://github.com/anonrig/fast-querystring#readme) | yes |
| `fast-uri` | 3.1.8, 4.2.1 | BSD-3-Clause | [upstream](https://github.com/fastify/fast-uri) | yes |
| `fast-xml-builder` | 1.3.1 | MIT | [upstream](https://github.com/NaturalIntelligence/fast-xml-builder#readme) | yes |
| `fast-xml-parser` | 5.11.2 | MIT | [upstream](https://github.com/NaturalIntelligence/fast-xml-parser#readme) | yes |
| `fastify` | 5.12.5 | MIT | [upstream](https://fastify.dev/) | yes |
| `fastify-plugin` | 5.1.0 | MIT | [upstream](https://github.com/fastify/fastify-plugin#readme) | yes |
| `fastq` | 1.20.3 | ISC | [upstream](https://github.com/mcollina/fastq#readme) | yes |
| `fdir` | 6.5.0 | MIT | [upstream](https://github.com/thecodrr/fdir#readme) | yes |
| `find-my-way` | 9.9.0 | MIT | [upstream](https://github.com/delvedor/find-my-way#readme) | yes |
| `foreground-child` | 3.3.1 | ISC | [upstream](https://github.com/tapjs/foreground-child#readme) | yes |
| `glob` | 11.1.0 | BlueOak-1.0.0 | [upstream](https://github.com/isaacs/node-glob#readme) | yes |
| `hls.js` | 1.7.3 | Apache-2.0 | [upstream](https://github.com/video-dev/hls.js) | yes |
| `html-escaper` | 3.0.3 | MIT | [upstream](https://github.com/WebReflection/html-escaper) | yes |
| `htmlparser2` | 10.1.0 | MIT | [upstream](https://github.com/fb55/htmlparser2#readme) | yes |
| `http-errors` | 2.0.1 | MIT | [upstream](https://github.com/jshttp/http-errors#readme) | yes |
| `https-proxy-agent` | 7.0.6 | MIT | [upstream](https://github.com/TooTallNate/proxy-agents#readme) | yes |
| `iconv-lite` | 0.6.3, 0.7.0, 0.7.3 | MIT | [upstream](https://github.com/pillarjs/iconv-lite) | yes |
| `inherits` | 2.0.4 | ISC | [upstream](https://github.com/isaacs/inherits#readme) | yes |
| `ip-address` | 10.7.3 | MIT | [upstream](https://github.com/beaugunderson/ip-address#readme) | yes |
| `ipaddr.js` | 2.5.0 | MIT | [upstream](https://github.com/whitequark/ipaddr.js#readme) | yes |
| `is-unsafe` | 2.0.2 | MIT | [upstream](https://github.com/NaturalIntelligence/is-unsafe#readme) | yes |
| `isexe` | 2.0.0 | ISC | [upstream](https://github.com/isaacs/isexe#readme) | yes |
| `jackspeak` | 4.2.3 | BlueOak-1.0.0 | [upstream](https://github.com/isaacs/jackspeak#readme) | yes |
| `jassub` | 2.5.16 | LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0 | [upstream](https://github.com/ThaUnknown/jassub) | yes |
| `json-schema-ref-resolver` | 3.0.0 | MIT | [upstream](https://github.com/fastify/json-schema-ref-resolver#readme) | yes |
| `json-schema-traverse` | 1.0.0 | MIT | [upstream](https://github.com/epoberezkin/json-schema-traverse#readme) | yes |
| `lfa-ponyfill` | 1.1.1 | MIT | [upstream](https://github.com/ThaUnknown/lfa-ponyfill) | **UNKNOWN / not found** |
| `light-my-request` | 6.6.0 | BSD-3-Clause | [upstream](https://github.com/fastify/light-my-request#readme) | yes |
| `lightningcss` | 1.33.0 | MPL-2.0 | [upstream](https://github.com/parcel-bundler/lightningcss#readme) | yes |
| `lightningcss-linux-x64-gnu` | 1.33.0 | MPL-2.0 | [upstream](https://github.com/parcel-bundler/lightningcss#readme) | yes |
| `lightningcss-linux-x64-musl` | 1.33.0 | MPL-2.0 | [upstream](https://github.com/parcel-bundler/lightningcss#readme) | yes |
| `linkedom` | 0.18.12 | ISC | [upstream](https://github.com/WebReflection/linkedom#readme) | yes |
| `lru-cache` | 11.5.3 | BlueOak-1.0.0 | [upstream](https://github.com/isaacs/node-lru-cache#readme) | yes |
| `lucide-react` | 1.49.0 | ISC | [upstream](https://lucide.dev) | yes |
| `mime` | 3.0.0 | MIT | [upstream](https://github.com/broofa/mime#readme) | yes |
| `minimatch` | 10.2.6 | BlueOak-1.0.0 | [upstream](https://github.com/isaacs/minimatch#readme) | yes |
| `minipass` | 7.1.3 | BlueOak-1.0.0 | [upstream](https://github.com/isaacs/minipass#readme) | yes |
| `ms` | 2.1.3 | MIT | [upstream](https://github.com/vercel/ms#readme) | yes |
| `nanoid` | 3.3.19 | MIT | [upstream](https://github.com/ai/nanoid#readme) | yes |
| `nth-check` | 2.1.1 | BSD-2-Clause | [upstream](https://github.com/fb55/nth-check) | yes |
| `on-exit-leak-free` | 2.1.2 | MIT | [upstream](https://github.com/mcollina/on-exit-or-gc#readme) | yes |
| `package-json-from-dist` | 1.0.1 | BlueOak-1.0.0 | [upstream](https://github.com/isaacs/package-json-from-dist#readme) | yes |
| `parse5` | 7.3.0 | MIT | [upstream](https://parse5.js.org) | yes |
| `parse5-htmlparser2-tree-adapter` | 7.1.0 | MIT | [upstream](https://parse5.js.org) | yes |
| `parse5-parser-stream` | 7.1.2 | MIT | [upstream](https://github.com/inikulin/parse5) | yes |
| `path-expression-matcher` | 1.6.2 | MIT | [upstream](https://github.com/NaturalIntelligence/path-expression-matcher#readme) | yes |
| `path-key` | 3.1.1 | MIT | [upstream](https://github.com/sindresorhus/path-key#readme) | yes |
| `path-scurry` | 2.0.2 | BlueOak-1.0.0 | [upstream](https://github.com/isaacs/path-scurry#readme) | yes |
| `pend` | 1.2.0 | MIT | [upstream](https://github.com/andrewrk/node-pend#readme) | yes |
| `picocolors` | 1.1.1 | ISC | [upstream](https://github.com/alexeyraspopov/picocolors#readme) | yes |
| `picomatch` | 4.0.7 | MIT | [upstream](https://github.com/micromatch/picomatch) | yes |
| `pino` | 10.3.1 | MIT | [upstream](https://getpino.io) | yes |
| `pino-abstract-transport` | 3.0.0 | MIT | [upstream](https://github.com/pinojs/pino-abstract-transport#readme) | yes |
| `pino-std-serializers` | 7.1.0 | MIT | [upstream](https://github.com/pinojs/pino-std-serializers#readme) | yes |
| `postcss` | 8.5.28 | MIT | [upstream](https://postcss.org/) | yes |
| `pretendard` | 1.3.9 | OFL-1.1 | [upstream](https://cactus.tistory.com/306) | yes |
| `process-warning` | 4.0.1, 5.1.0 | MIT | [upstream](https://github.com/fastify/fastify-warning#readme) | yes |
| `quick-format-unescaped` | 4.0.4 | MIT | [upstream](https://github.com/davidmarkclements/quick-format#readme) | yes |
| `quickjs-emscripten-core` | 0.32.0 | MIT | [upstream](https://github.com/justjake/quickjs-emscripten#readme) | yes |
| `react` | 19.3.0 | MIT | [upstream](https://react.dev/) | yes |
| `react-dom` | 19.3.0 | MIT | [upstream](https://react.dev/) | yes |
| `react-router` | 7.18.4 | MIT | [upstream](https://github.com/remix-run/react-router#readme) | yes |
| `react-router-dom` | 7.18.4 | MIT | [upstream](https://github.com/remix-run/react-router#readme) | yes |
| `real-require` | 0.2.0, 1.0.0 | MIT | [upstream](https://github.com/pinojs/real-require) | yes |
| `require-from-string` | 2.0.2 | MIT | [upstream](https://github.com/floatdrop/require-from-string#readme) | yes |
| `ret` | 0.5.0 | MIT | [upstream](https://github.com/fent/ret.js#readme) | yes |
| `reusify` | 1.1.0 | MIT | [upstream](https://github.com/mcollina/reusify#readme) | yes |
| `rfdc` | 1.4.1 | MIT | [upstream](https://github.com/davidmarkclements/rfdc#readme) | yes |
| `rolldown` | 1.2.12 | MIT | [upstream](https://rolldown.rs/) | yes |
| `rvfc-polyfill` | 1.0.8 | GPL-3.0 | [upstream](https://github.com/ThaUnknown/rvfc-polyfill#readme) | yes |
| `safe-buffer` | 5.2.1 | MIT | [upstream](https://github.com/feross/safe-buffer) | yes |
| `safe-regex2` | 5.1.1 | MIT | [upstream](https://github.com/fastify/safe-regex2) | yes |
| `safe-stable-stringify` | 2.5.0 | MIT | [upstream](https://github.com/BridgeAR/safe-stable-stringify#readme) | yes |
| `safer-buffer` | 2.1.2 | MIT | [upstream](https://github.com/ChALkeR/safer-buffer#readme) | yes |
| `scheduler` | 0.28.0 | MIT | [upstream](https://react.dev/) | yes |
| `secure-json-parse` | 4.1.0 | BSD-3-Clause | [upstream](https://github.com/fastify/secure-json-parse#readme) | yes |
| `semver` | 7.8.5 | ISC | [upstream](https://github.com/npm/node-semver#readme) | yes |
| `set-cookie-parser` | 2.7.2 | MIT | [upstream](https://github.com/nfriedly/set-cookie-parser) | yes |
| `setprototypeof` | 1.2.0 | ISC | [upstream](https://github.com/wesleytodd/setprototypeof) | yes |
| `sharp` | 0.34.5 | Apache-2.0 | [upstream](https://sharp.pixelplumbing.com) | yes |
| `shebang-command` | 2.0.0 | MIT | [upstream](https://github.com/kevva/shebang-command#readme) | yes |
| `shebang-regex` | 3.0.0 | MIT | [upstream](https://github.com/sindresorhus/shebang-regex#readme) | yes |
| `signal-exit` | 4.1.0 | ISC | [upstream](https://github.com/tapjs/signal-exit#readme) | yes |
| `smart-buffer` | 4.2.0 | MIT | [upstream](https://github.com/JoshGlazebrook/smart-buffer/) | yes |
| `socks` | 2.8.10 | MIT | [upstream](https://github.com/JoshGlazebrook/socks/) | yes |
| `sonic-boom` | 4.2.1 | MIT | [upstream](https://github.com/pinojs/sonic-boom#readme) | yes |
| `source-map-js` | 1.2.2 | BSD-3-Clause | [upstream](https://github.com/7rulnik/source-map-js) | yes |
| `split2` | 4.2.0 | ISC | [upstream](https://github.com/mcollina/split2#readme) | yes |
| `statuses` | 2.0.2 | MIT | [upstream](https://github.com/jshttp/statuses#readme) | yes |
| `strnum` | 2.4.2 | MIT | [upstream](https://github.com/NaturalIntelligence/strnum#readme) | yes |
| `thread-stream` | 4.2.0 | MIT | [upstream](https://github.com/mcollina/thread-stream#readme) | yes |
| `throughput` | 1.0.2 | MIT | [upstream](https://github.com/ThaUnknown/throughput#readme) | **UNKNOWN / not found** |
| `tinyglobby` | 0.2.17 | MIT | [upstream](https://superchupu.dev/tinyglobby) | yes |
| `toad-cache` | 3.7.4 | MIT | [upstream](https://github.com/kibertoad/toad-cache) | yes |
| `toidentifier` | 1.0.1 | MIT | [upstream](https://github.com/component/toidentifier#readme) | yes |
| `tsx` | 4.23.15 | MIT | [upstream](https://tsx.hirok.io) | yes |
| `typescript` | 5.9.3, 7.0.2 | Apache-2.0 | [upstream](https://www.typescriptlang.org/) | yes |
| `uhyphen` | 0.2.0 | ISC | [upstream](https://github.com/WebReflection/uhyphen#readme) | yes |
| `undici` | 7.30.0 | MIT | [upstream](https://undici.nodejs.org) | yes |
| `undici-types` | 6.21.0 | MIT | [upstream](https://undici.nodejs.org) | yes |
| `vite` | 8.3.2 | MIT | [upstream](https://vite.dev) | yes |
| `whatwg-encoding` | 3.1.1 | MIT | [upstream](https://github.com/jsdom/whatwg-encoding#readme) | yes |
| `whatwg-mimetype` | 4.0.0 | MIT | [upstream](https://github.com/jsdom/whatwg-mimetype#readme) | yes |
| `which` | 2.0.2 | ISC | [upstream](https://github.com/isaacs/node-which#readme) | yes |
| `xml-naming` | 0.3.0 | MIT | [upstream](https://github.com/NaturalIntelligence/xml-naming#readme) | yes |
| `yauzl` | 3.4.0 | MIT | [upstream](https://github.com/thejoshwolfe/yauzl) | yes |

## Maven runtime JAR inventory

Pinned coordinates and hashes are in `services/aniyomi-worker/pom.xml` and `dependencies.lock.json`. The JARs are downloaded during build and retain embedded `META-INF` notices. POM declarations do not resolve shaded components. Preserve the complete embedded licenses and NOTICE files in the release image.

**Unresolved before binary redistribution:** `xpp3` mixes legacy Indiana University/Apache-1.1/public-domain material; `xmlParserAPIs` carries W3C DOM and SAX terms; `d2j-external` shaded component attribution is incomplete; ANTLR's exact BSD notice needs collection. These are not blanket Apache/GPL-compatible declarations.

| Pinned JAR | Coordinate / origin | License / evidence |

|---|---|---|
| `android-4.1.1.4.jar` | [com.google.android:android:4.1.1.4](https://repo.maven.apache.org/maven2/com/google/android/android/4.1.1.4/android-4.1.1.4.pom) | Apache 2.0 — POM |
| `annotations-13.0.jar` | [org.jetbrains:annotations:13.0](https://repo.maven.apache.org/maven2/org/jetbrains/annotations/13.0/annotations-13.0.pom) | The Apache Software License, Version 2.0 — POM |
| `antlr-runtime-3.5.3.jar` | [org.antlr:antlr-runtime:3.5.3](https://repo.maven.apache.org/maven2/org/antlr/antlr-runtime/3.5.3/antlr-runtime-3.5.3.pom) | BSD — antlr-master 3.5.3 parent POM; 세부 조항 원문 미확인 |
| `antlr4-runtime-4.13.2.jar` | [org.antlr:antlr4-runtime:4.13.2](https://repo.maven.apache.org/maven2/org/antlr/antlr4-runtime/4.13.2/antlr4-runtime-4.13.2.pom) | BSD-3-Clause — antlr4-master 4.13.2 parent POM |
| `apk-parser-2.6.10.jar` | [net.dongliu:apk-parser:2.6.10](https://repo.maven.apache.org/maven2/net/dongliu/apk-parser/2.6.10/apk-parser-2.6.10.pom) | The BSD 2-Clause License — POM |
| `apksig-8.10.1.jar` | [com.android.tools.build:apksig:8.10.1](https://dl.google.com/dl/android/maven2/com/android/tools/build/apksig/8.10.1/apksig-8.10.1.pom) | The Apache Software License, Version 2.0 — POM |
| `asm-analysis-9.10.1.jar` | [org.ow2.asm:asm-analysis:9.10.1](https://repo.maven.apache.org/maven2/org/ow2/asm/asm-analysis/9.10.1/asm-analysis-9.10.1.pom) | BSD-3-Clause — POM |
| `asm-commons-9.10.1.jar` | [org.ow2.asm:asm-commons:9.10.1](https://repo.maven.apache.org/maven2/org/ow2/asm/asm-commons/9.10.1/asm-commons-9.10.1.pom) | BSD-3-Clause — POM |
| `asm-tree-9.10.1.jar` | [org.ow2.asm:asm-tree:9.10.1](https://repo.maven.apache.org/maven2/org/ow2/asm/asm-tree/9.10.1/asm-tree-9.10.1.pom) | BSD-3-Clause — POM |
| `asm-util-9.10.1.jar` | [org.ow2.asm:asm-util:9.10.1](https://repo.maven.apache.org/maven2/org/ow2/asm/asm-util/9.10.1/asm-util-9.10.1.pom) | BSD-3-Clause — POM |
| `commons-codec-1.3.jar` | [commons-codec:commons-codec:1.3](https://repo.maven.apache.org/maven2/commons-codec/commons-codec/1.3/commons-codec-1.3.pom) | Apache-2.0 — 고정 해시 JAR 원문 확인; Logging NOTICE 있음 |
| `commons-logging-1.1.1.jar` | [commons-logging:commons-logging:1.1.1](https://repo.maven.apache.org/maven2/commons-logging/commons-logging/1.1.1/commons-logging-1.1.1.pom) | Apache-2.0 — 고정 해시 JAR 원문 확인; Logging NOTICE 있음 |
| `d2j-base-cmd-2.4.37.jar` | [de.femtopedia.dex2jar:d2j-base-cmd:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/d2j-base-cmd/2.4.37/d2j-base-cmd-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `d2j-external-2.4.37.jar` | [de.femtopedia.dex2jar:d2j-external:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/d2j-external/2.4.37/d2j-external-2.4.37.pom) | Apache-2.0 — POM 선언; shaded 구성 세부 고지 미확정 |
| `d2j-jasmin-2.4.37.jar` | [de.femtopedia.dex2jar:d2j-jasmin:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/d2j-jasmin/2.4.37/d2j-jasmin-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `d2j-smali-2.4.37.jar` | [de.femtopedia.dex2jar:d2j-smali:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/d2j-smali/2.4.37/d2j-smali-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-ir-2.4.37.jar` | [de.femtopedia.dex2jar:dex-ir:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-ir/2.4.37/dex-ir-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-reader-2.4.37.jar` | [de.femtopedia.dex2jar:dex-reader:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-reader/2.4.37/dex-reader-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-reader-api-2.4.37.jar` | [de.femtopedia.dex2jar:dex-reader-api:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-reader-api/2.4.37/dex-reader-api-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-tools-2.4.37.jar` | [de.femtopedia.dex2jar:dex-tools:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-tools/2.4.37/dex-tools-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-translator-2.4.37.jar` | [de.femtopedia.dex2jar:dex-translator:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-translator/2.4.37/dex-translator-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `dex-writer-2.4.37.jar` | [de.femtopedia.dex2jar:dex-writer:2.4.37](https://repo.maven.apache.org/maven2/de/femtopedia/dex2jar/dex-writer/2.4.37/dex-writer-2.4.37.pom) | The Apache License, Version 2.0 — POM |
| `httpclient-4.0.1.jar` | [org.apache.httpcomponents:httpclient:4.0.1](https://repo.maven.apache.org/maven2/org/apache/httpcomponents/httpclient/4.0.1/httpclient-4.0.1.pom) | Apache License — POM |
| `httpcore-4.0.1.jar` | [org.apache.httpcomponents:httpcore:4.0.1](https://repo.maven.apache.org/maven2/org/apache/httpcomponents/httpcore/4.0.1/httpcore-4.0.1.pom) | Apache License — POM |
| `injekt-koin-ee267b2e27.jar` | [com.github.null2264:injekt-koin:ee267b2e27](https://jitpack.io/com/github/null2264/injekt-koin/ee267b2e27/injekt-koin-ee267b2e27.pom) | MIT — POM |
| `jackson-annotations-2.20.jar` | [com.fasterxml.jackson.core:jackson-annotations:2.20](https://repo.maven.apache.org/maven2/com/fasterxml/jackson/core/jackson-annotations/2.20/jackson-annotations-2.20.pom) | The Apache Software License, Version 2.0 — POM |
| `json-20250517.jar` | [org.json:json:20250517](https://repo.maven.apache.org/maven2/org/json/json/20250517/json-20250517.pom) | Public Domain — POM |
| `jsoup-1.22.2.jar` | [org.jsoup:jsoup:1.22.2](https://repo.maven.apache.org/maven2/org/jsoup/jsoup/1.22.2/jsoup-1.22.2.pom) | The MIT License — POM |
| `koin-core-jvm-4.0.0.jar` | [io.insert-koin:koin-core-jvm:4.0.0](https://repo.maven.apache.org/maven2/io/insert-koin/koin-core-jvm/4.0.0/koin-core-jvm-4.0.0.pom) | The Apache Software License, Version 2.0 — POM |
| `kotlin-reflect-2.4.0.jar` | [org.jetbrains.kotlin:kotlin-reflect:2.4.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-reflect/2.4.0/kotlin-reflect-2.4.0.pom) | Apache-2.0 — POM |
| `kotlin-stdlib-2.4.0.jar` | [org.jetbrains.kotlin:kotlin-stdlib:2.4.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.4.0/kotlin-stdlib-2.4.0.pom) | Apache-2.0 — POM |
| `kotlinx-coroutines-core-jvm-1.11.0.jar` | [org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.11.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.11.0/kotlinx-coroutines-core-jvm-1.11.0.pom) | Apache-2.0 — POM |
| `kotlinx-serialization-core-jvm-1.11.0.jar` | [org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.11.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/kotlinx-serialization-core-jvm/1.11.0/kotlinx-serialization-core-jvm-1.11.0.pom) | Apache-2.0 — POM |
| `kotlinx-serialization-json-jvm-1.11.0.jar` | [org.jetbrains.kotlinx:kotlinx-serialization-json-jvm:1.11.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/kotlinx-serialization-json-jvm/1.11.0/kotlinx-serialization-json-jvm-1.11.0.pom) | Apache-2.0 — POM |
| `kotlinx-serialization-json-okio-jvm-1.11.0.jar` | [org.jetbrains.kotlinx:kotlinx-serialization-json-okio-jvm:1.11.0](https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/kotlinx-serialization-json-okio-jvm/1.11.0/kotlinx-serialization-json-okio-jvm-1.11.0.pom) | Apache-2.0 — POM |
| `okhttp-jvm-5.4.0.jar` | [com.squareup.okhttp3:okhttp-jvm:5.4.0](https://repo.maven.apache.org/maven2/com/squareup/okhttp3/okhttp-jvm/5.4.0/okhttp-jvm-5.4.0.pom) | The Apache Software License, Version 2.0 — POM |
| `okio-jvm-3.17.0.jar` | [com.squareup.okio:okio-jvm:3.17.0](https://repo.maven.apache.org/maven2/com/squareup/okio/okio-jvm/3.17.0/okio-jvm-3.17.0.pom) | The Apache Software License, Version 2.0 — POM |
| `opengl-api-gl1.1-android-2.1_r1.jar` | [org.khronos:opengl-api:gl1.1-android-2.1_r1](https://repo.maven.apache.org/maven2/org/khronos/opengl-api/gl1.1-android-2.1_r1/opengl-api-gl1.1-android-2.1_r1.pom) | Apache 2.0 — POM |
| `rxjava-1.3.8.jar` | [io.reactivex:rxjava:1.3.8](https://repo.maven.apache.org/maven2/io/reactivex/rxjava/1.3.8/rxjava-1.3.8.pom) | The Apache Software License, Version 2.0 — POM |
| `stately-concurrency-jvm-2.1.0.jar` | [co.touchlab:stately-concurrency-jvm:2.1.0](https://repo.maven.apache.org/maven2/co/touchlab/stately-concurrency-jvm/2.1.0/stately-concurrency-jvm-2.1.0.pom) | The Apache Software License, Version 2.0 — POM |
| `stately-concurrent-collections-jvm-2.1.0.jar` | [co.touchlab:stately-concurrent-collections-jvm:2.1.0](https://repo.maven.apache.org/maven2/co/touchlab/stately-concurrent-collections-jvm/2.1.0/stately-concurrent-collections-jvm-2.1.0.pom) | The Apache Software License, Version 2.0 — POM |
| `stately-strict-jvm-2.1.0.jar` | [co.touchlab:stately-strict-jvm:2.1.0](https://repo.maven.apache.org/maven2/co/touchlab/stately-strict-jvm/2.1.0/stately-strict-jvm-2.1.0.pom) | The Apache Software License, Version 2.0 — POM |
| `xmlParserAPIs-2.6.2.jar` | [xerces:xmlParserAPIs:2.6.2](https://repo.maven.apache.org/maven2/xerces/xmlParserAPIs/2.6.2/xmlParserAPIs-2.6.2.pom) | W3C DOM 소프트웨어/문서 고지 + SAX public domain — 고정 해시 JAR 확인 |
| `xpp3-1.1.4c.jar` | [xpp3:xpp3:1.1.4c](https://repo.maven.apache.org/maven2/xpp3/xpp3/1.1.4c/xpp3-1.1.4c.pom) | Indiana University Extreme! Lab 1.1.1 + Public Domain + Apache 1.1 — POM 열거, 파일별 적용/호환 미확정 |

## Data and release obligations

TMDB/AniList/AniSkip/Anissia/Jimaku responses, user media, subtitles and translations are external data and not covered by MOA's code license. Redistribution permissions are **UNKNOWN** unless separately obtained. Use synthetic fixtures.

Publish each binary with the full applicable notices and its exact Corresponding Source, modifications and build instructions. Include GPL browser code, MPL modified files, LGPL WASM/native source and required replacement/relink material. A link to an unpinned upstream repository or this inventory alone does not fulfill those obligations. The **UNKNOWN** items above are owner action items, not assertions of permission.
# ByeDPI

The Node lookup relay bundles the unmodified ByeDPI v0.17.3 Linux x86_64 binary
from https://github.com/hufrea/byedpi under the MIT license.
Copyright and license: `vendor/byedpi/LICENSE`. Release provenance and checksums:
`vendor/byedpi/README.md`. This binary is not shipped to browsers.

## Subtitle archive decoder

`7z-wasm@1.2.0` (7-Zip 24.09) replaces `libarchive-wasm` for Unicode archive filenames. The unmodified decoder is loaded as a separate JS/WASM module in a server worker for online subtitles and a browser worker for local imports. Full supplied licenses and checksums are in [LICENSES/7z-wasm](LICENSES/7z-wasm/README.md). The module uses LGPL-2.1-or-later with the included unRAR restriction; it is not relicensed under MOA's GPL. Package integrity is pinned in `pnpm-lock.yaml`.

`fflate@0.8.2` provides browser ZIP decompression under MIT; its full notice is in `LICENSES/npm/fflate-0.8.2/LICENSE` and the browser runtime notice bundle. ZIP filename decoding uses the original UTF-8/CP949 name bytes.
