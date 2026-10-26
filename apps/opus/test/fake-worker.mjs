import { createInterface } from 'node:readline';
console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.texts[0] === 'exit') process.exit(3);
  if (request.texts[0] === 'slow') await new Promise(resolve => setTimeout(resolve, 5000));
  console.log(JSON.stringify({ translations: request.texts.map(() => 'Перевод.') }));
}
