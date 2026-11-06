'use strict';

/**
 * Daybreak steht unter der AGPL-3.0. Sie verlangt, dass alle, die eine veränderte Fassung über
 * das Netz nutzen, deren Quellcode bekommen können. Deshalb zeigt die Oberfläche immer einen
 * Link dorthin. Wer Daybreak verändert betreibt, setzt DAYBREAK_SOURCE_URL auf den eigenen Code.
 */

const DEFAULT_SOURCE_URL = 'https://github.com/schnierk/daybreak';

function sourceUrl(env = process.env) {
  const configured = String(env.DAYBREAK_SOURCE_URL || '').trim();
  return /^https?:\/\/\S+$/.test(configured) ? configured : DEFAULT_SOURCE_URL;
}

module.exports = { DEFAULT_SOURCE_URL, sourceUrl };
