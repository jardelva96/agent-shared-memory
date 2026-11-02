import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const load = file => import(pathToFileURL(`${process.env.PROJETO}/src/${file}`).href);
const { contarPalavras } = await load('texto.js');

test('pontuacao', () => assert.equal(contarPalavras('Olá, mundo!'), 2));
test('hifen e apostrofo dentro', () => assert.equal(contarPalavras("guarda-chuva e d'água"), 3));
test('vazio', () => assert.equal(contarPalavras(''), 0));
test('so separadores', () => assert.equal(contarPalavras('  - - , . '), 0));
test('numeros contam', () => assert.equal(contarPalavras('3 pães'), 2));
test('quebra de linha', () => assert.equal(contarPalavras('ação\nreação'), 2));
test('hifen solto nas pontas', () => assert.equal(contarPalavras('-fim- inicio-'), 2));
test('acentos', () => assert.equal(contarPalavras('Ünïcödé çà'), 2));
