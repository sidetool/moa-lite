import iconv from "iconv-lite";
import { load } from "cheerio";

export type SubtitleEncoding = "utf8" | "utf16le" | "utf16be" | "cp949";

export function detectSubtitleEncoding(input: Uint8Array): SubtitleEncoding {
  const buf = Buffer.from(input);
  if (buf[0] === 0xff && buf[1] === 0xfe) return "utf16le";
  if (buf[0] === 0xfe && buf[1] === 0xff) return "utf16be";
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf8";
  const sample = buf.subarray(0, 4096);
  let evenNulls = 0, oddNulls = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) oddNulls++; else evenNulls++; }
  const threshold = Math.max(2, sample.length * 0.08);
  if (oddNulls >= threshold && oddNulls > evenNulls * 2) return "utf16le";
  if (evenNulls >= threshold && evenNulls > oddNulls * 2) return "utf16be";
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); return "utf8"; }
  catch { return "cp949"; } // CP949 is a superset of EUC-KR, which needs no separate fallback.
}

export function decodeSubtitleBuffer(input: Uint8Array, encoding?: string): string {
  return iconv.decode(Buffer.from(input), encoding && iconv.encodingExists(encoding) ? encoding : detectSubtitleEncoding(input)).replace(/^\uFEFF/, "");
}

interface Cue { start: number; end: number; text: string }

export function timestamp(ms: number): string {
  const whole = Math.round(ms);
  return `${Math.floor(whole / 3_600_000).toString().padStart(2, "0")}:${Math.floor(whole / 60_000 % 60).toString().padStart(2, "0")}:${Math.floor(whole / 1000 % 60).toString().padStart(2, "0")}.${(whole % 1000).toString().padStart(3, "0")}`;
}

function timeMs(value: string): number | undefined {
  const match = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return undefined;
  return Number(match[1] ?? 0) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1000 + Number(match[4]!.padEnd(3, "0"));
}

function plainText(fragment: string): string {
  const $ = load(fragment.replace(/<br\s*\/?\s*>/gi, "\n"), null, false);
  $("script,style,head").remove();
  return $.root().text().replace(/\{\\[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ")
    .replace(/\u00a0/g, " ").split("\n").map(line => line.trim()).filter(Boolean).join("\n")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(cues: Cue[]): string {
  const valid = cues.filter(c => c.text && Number.isFinite(c.start) && c.start >= 0 && c.end > c.start).sort((a, b) => a.start - b.start);
  if (!valid.length) throw new Error("No valid subtitle cues");
  return "WEBVTT\n\n" + valid.map(c => `${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.text}\n`).join("\n") + "\n";
}

function smiToVtt(text: string): string {
  const stripped = text.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "");
  const syncs = [...stripped.matchAll(/<sync\b[^>]*\bstart\s*=\s*["']?(\d+)["']?[^>]*>/gi)];
  const koreanClasses = new Set(["krcc", "kocc", "korean", "ko"]);
  for (const match of text.matchAll(/\.([\w-]+)\s*\{([^}]+)\}/g)) {
    if (/lang\s*:\s*ko(?:-kr)?|name\s*:\s*korean/i.test(match[2]!)) koreanClasses.add(match[1]!.toLowerCase());
  }
  const cues: Cue[] = [];
  for (let i = 0; i < syncs.length; i++) {
    const sync = syncs[i]!;
    const start = Number(sync[1]);
    const fragment = stripped.slice(sync.index! + sync[0].length, syncs[i + 1]?.index ?? stripped.length).replace(/<\/(?:body|sami)>/gi, "");
    const paragraphs = [...fragment.matchAll(/<p\b([^>]*)>([\s\S]*?)(?=<p\b|$)/gi)];
    let selected = fragment;
    if (paragraphs.length) {
      const korean = paragraphs.filter(p => {
        const cls = p[1]!.match(/\bclass\s*=\s*["']?([\w-]+)/i)?.[1]?.toLowerCase();
        return cls && koreanClasses.has(cls);
      });
      // If a Korean track exists, an empty Korean clear cue must not select another language.
      selected = (korean.length ? korean : [paragraphs[0]!]).map(p => p[2]).join("\n");
    }
    cues.push({ start, end: syncs[i + 1] ? Number(syncs[i + 1]![1]) : start + 5000, text: plainText(selected) });
  }
  return render(cues);
}

function timedTextToVtt(text: string): string {
  const cues: Cue[] = [];
  for (const block of text.split(/\n[\t ]*\n/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex(line => line.includes("-->"));
    if (timing < 0) continue;
    const match = lines[timing]!.match(/^\s*(\S+)\s*-->\s*(\S+)/);
    if (!match) continue;
    const start = timeMs(match[1]!), end = timeMs(match[2]!);
    if (start === undefined || end === undefined) continue;
    cues.push({ start, end, text: plainText(lines.slice(timing + 1).join("\n")) });
  }
  return render(cues);
}

export function toVtt(content: string, ext: string): string {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const format = ext.toLowerCase().replace(/^\./, "");
  if (["ass", "ssa"].includes(format)) throw new Error("ASS/SSA must be kept as ASS; use convertSubtitle");
  if (format === "smi" || format === "sami") return smiToVtt(text);
  if (format === "srt") return timedTextToVtt(text);
  if (format === "vtt") {
    if (!/^WEBVTT(?:[\t ].*)?\n/.test(text)) throw new Error("Invalid WebVTT header");
    // Validate timing while preserving WebVTT positioning, NOTE, STYLE and cue markup.
    timedTextToVtt(text);
    return text.endsWith("\n") ? text : text + "\n";
  }
  throw new Error(`Unsupported subtitle extension: ${ext}`);
}

export function detectSubtitleFormat(text: string): "ass" | "smi" | "srt" | "vtt" | undefined {
  const sample = text.slice(0, 32_000);
  if (/<!doctype\s+html|<html\b/i.test(sample)) return undefined;
  if (/^\s*\[Script Info\]/im.test(sample) && /^Dialogue\s*:/im.test(text)) return "ass";
  if (/<sami\b/i.test(sample) || /<sync\b[^>]*start\s*=/i.test(text)) return "smi";
  if (/^WEBVTT(?:\s|$)/.test(sample)) return "vtt";
  if (/\d{1,}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/.test(sample)) return "srt";
  return undefined;
}

export function convertSubtitle(content: string, ext?: string): { format: "ass" | "vtt"; content: string } {
  const detected = detectSubtitleFormat(content);
  if (!detected) throw new Error("Response is not a supported subtitle");
  const text = content.replace(/^\uFEFF/, "");
  if (detected === "ass") return { format: "ass", content: text };
  // Content wins over a mislabeled filename or generic download endpoint.
  return { format: "vtt", content: toVtt(text, detected) };
}
