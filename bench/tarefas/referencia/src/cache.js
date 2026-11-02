export class LRU {
  #capacidade;
  #itens = new Map();

  constructor(capacidade) {
    if (!Number.isInteger(capacidade) || capacidade < 1) throw new RangeError('capacidade invalida');
    this.#capacidade = capacidade;
  }

  get size() {
    return this.#itens.size;
  }

  get(chave) {
    if (!this.#itens.has(chave)) return undefined;
    const valor = this.#itens.get(chave);
    this.#itens.delete(chave);
    this.#itens.set(chave, valor);
    return valor;
  }

  set(chave, valor) {
    this.#itens.delete(chave);
    this.#itens.set(chave, valor);
    if (this.#itens.size > this.#capacidade) this.#itens.delete(this.#itens.keys().next().value);
    return this;
  }

  has(chave) {
    return this.#itens.has(chave);
  }

  delete(chave) {
    return this.#itens.delete(chave);
  }
}
