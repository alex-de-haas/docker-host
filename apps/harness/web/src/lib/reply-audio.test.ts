// @vitest-environment jsdom
import { expect, it } from "vitest";
import { readableReplyText, speechChunks } from "./reply-audio";

it("reads the visible Russian section and descendants through the next equal/higher source rank", () => {
  const root = document.createElement("div");
  root.innerHTML = '<h4 data-speech-level="1">Доклад</h4><p>Вступление</p><h4 data-speech-level="2">Смета<button>Read</button></h4><p>Ирина: <strong>125</strong> евро.</p><h5 data-speech-level="3">Ноябрь</h5><p><a href="/private">Тариф</a> 42.</p><h4 data-speech-level="2">Дальше</h4><p hidden>Скрытый текст</p><p>Конец</p>';
  expect(readableReplyText(root, root.children[2] as HTMLElement)).toBe("Смета\nИрина: 125 евро.\nНоябрь\nТариф 42.");
  expect(readableReplyText(root)).toBe("Доклад\nВступление\nСмета\nИрина: 125 евро.\nНоябрь\nТариф 42.\nДальше\nКонец");
});
it("preserves all characters and surrogate pairs across bounded requests", () => {
  const text = "Смета: 125 евро.\nЛена 🦊 и Роберт.";
  for (let limit = 2; limit < 12; limit++) {
    const chunks = [...speechChunks(text, limit)];
    expect(chunks.join("")).toBe(text);
    expect(chunks.every(part => part.length <= limit && !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
  }
});
