import { catalogs, localeMetadata, type Language, type MessageKey } from './localization-catalogs.ts';
export type { Language };
export type TranslationKey = MessageKey;
export type MessageParameters = Readonly<Record<string, string | number>>;
// A bounded cache of app-created dynamic labels lets visible status fields
// change language without parsing arbitrary text or touching conversation data.
const dynamicLabels = new Map<string, { key: TranslationKey; values: MessageParameters }>();
export const supportedLanguages = (Object.keys(localeMetadata) as Language[])
  .sort((a, b) => localeMetadata[a].order - localeMetadata[b].order);
export const languageName = (value: Language): string => localeMetadata[value].name;
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.hasOwn(catalogs, value);
}
let language: Language = 'ja'; // Application startup resolves the host locale before rendering.
export function setLanguage(value: Language): void { language = isLanguage(value) ? value : 'en'; }
export function getLanguage(): Language { return language; }
export function speechLocale(): string { return localeMetadata[language].speechLocale; }
export function message(key: TranslationKey, locale: Language, values: MessageParameters = {}): string {
  const template = catalogs[locale]?.[key] || catalogs.en[key];
  // Replace once: parameter contents (including braces or dollar signs) are data.
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : token);
}
export function t(key: TranslationKey, values?: MessageParameters): string {
  const text = message(key, language, values);
  if (values && Object.keys(values).length) {
    dynamicLabels.set(text, { key, values: { ...values } });
    if (dynamicLabels.size > 256) dynamicLabels.delete(dynamicLabels.keys().next().value!);
  }
  return text;
}
export function seconds(value: string | number): string { return t('even.seconds', { value }); }
export function chooseLanguage(preferred: string, saved?: string | null): Language {
  if (isLanguage(saved)) return saved;
  const locale = preferred.toLowerCase();
  // Retain existing Japanese-prefix behavior, including legacy host values.
  return supportedLanguages.find(value => locale === value || locale.startsWith(`${value}-`) || locale.startsWith(`${value}_`)
    || ((localeMetadata[value] as { legacyPrefix?: boolean }).legacyPrefix === true && locale.startsWith(value))) ?? 'en';
}

/** Only for app-owned status labels; never call on conversation/user content. */
export function translateLabel(value: string): string {
  const dynamic = dynamicLabels.get(value);
  if (dynamic) return t(dynamic.key, dynamic.values);
  for (const key of Object.keys(catalogs.en) as TranslationKey[]) {
    if (supportedLanguages.some(locale => catalogs[locale][key] === value)) return t(key);
  }
  return value;
}
