const TABELA = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
];

export function paraRomano(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) throw new RangeError('fora de 1..3999');
  let s = '';
  for (const [valor, letras] of TABELA) {
    while (n >= valor) {
      s += letras;
      n -= valor;
    }
  }
  return s;
}

export function deRomano(texto) {
  if (typeof texto !== 'string' || !/^[MDCLXVI]+$/.test(texto)) throw new RangeError('invalido');
  let n = 0;
  let i = 0;
  for (const [valor, letras] of TABELA) {
    while (texto.startsWith(letras, i)) {
      n += valor;
      i += letras.length;
    }
  }
  if (i !== texto.length || n < 1 || n > 3999 || paraRomano(n) !== texto) throw new RangeError('nao canonico');
  return n;
}
