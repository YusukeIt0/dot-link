export const baseUrl = 'https://yusukeit0.github.io/dot-link/';

export const languages = [
  ['en', 'English'], ['ja', '日本語'], ['zh-Hant', '繁體中文'],
  ['zh-Hans', '简体中文'], ['ko', '한국어'], ['ar', 'العربية'],
  ['fr', 'Français'], ['de', 'Deutsch'],
];

export const pageUrl = (lang) => `${baseUrl}${lang === 'en' ? '' : `${lang}/`}`;
