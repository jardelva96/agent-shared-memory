export function mesclarIntervalos(lista) {
  for (const [ini, fim] of lista) if (ini > fim) throw new RangeError('inicio maior que fim');
  const ordenada = lista.map(([ini, fim]) => [ini, fim]).sort((a, b) => a[0] - b[0]);
  const saida = [];
  for (const atual of ordenada) {
    const ultimo = saida[saida.length - 1];
    if (ultimo && ultimo[1] >= atual[0]) ultimo[1] = Math.max(ultimo[1], atual[1]);
    else saida.push(atual);
  }
  return saida;
}
