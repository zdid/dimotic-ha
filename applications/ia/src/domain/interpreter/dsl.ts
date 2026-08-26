/**
 * Compilateur du DSL de gabarits (voir plan de mise en œuvre — section "Notation des gabarits") :
 * `<lieu>`/`<quoi>`/`<valeur>`/`<duree>`/`<heure>`/`<date>`/`<datetime>` (catégories terminales),
 * `<categorie#nomcapture>` (renomme une capture dupliquée), `<enum:table>`/`<verbe:table>` (table
 * nommée du vocabulaire), `<gabarit:nom>` (composition), `(a|b|c)` alternative, `?` facultatif, `*`
 * répétable. Compile une chaîne en un arbre `PatternNode`, consommé par `grammar.ts`.
 */

export type PatternNode =
  | { kind: 'literal'; word: string }
  | { kind: 'category'; category: string; captureName: string }
  | { kind: 'enum'; source: 'verbe' | 'enum'; table: string; captureName: string }
  | { kind: 'gabaritRef'; name: string }
  | { kind: 'sequence'; items: PatternNode[] }
  | { kind: 'alternation'; options: PatternNode[] }
  | { kind: 'optional'; inner: PatternNode }
  | { kind: 'repeat'; inner: PatternNode };

const TERMINAL_CATEGORIES = new Set(['lieu', 'quoi', 'valeur', 'duree', 'heure', 'date', 'datetime']);

interface DslToken {
  type: 'word' | 'lparen' | 'rparen' | 'pipe' | 'question' | 'star' | 'angle';
  value: string;
}

function tokenizeDsl(pattern: string): DslToken[] {
  const tokens: DslToken[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { tokens.push({ type: 'lparen', value: '(' }); i++; continue; }
    if (c === ')') {
      tokens.push({ type: 'rparen', value: ')' });
      i++;
      if (pattern[i] === '?') { tokens.push({ type: 'question', value: '?' }); i++; }
      else if (pattern[i] === '*') { tokens.push({ type: 'star', value: '*' }); i++; }
      continue;
    }
    if (c === '|') { tokens.push({ type: 'pipe', value: '|' }); i++; continue; }
    if (c === '<') {
      const end = pattern.indexOf('>', i);
      if (end === -1) throw new Error(`DSL invalide (chevron non fermé) : "${pattern}"`);
      tokens.push({ type: 'angle', value: pattern.slice(i + 1, end) });
      i = end + 1;
      if (pattern[i] === '?') { tokens.push({ type: 'question', value: '?' }); i++; }
      else if (pattern[i] === '*') { tokens.push({ type: 'star', value: '*' }); i++; }
      continue;
    }
    // mot littéral : jusqu'au prochain séparateur DSL, espace, ou suffixe ?/* (ne doit pas être
    // absorbé dans le mot, sinon "a?" deviendrait le littéral "a?" au lieu de "a" + facultatif)
    let j = i;
    while (j < pattern.length && !/[\s()|<?*]/.test(pattern[j])) j++;
    tokens.push({ type: 'word', value: pattern.slice(i, j) });
    i = j;
    if (pattern[i] === '?') { tokens.push({ type: 'question', value: '?' }); i++; }
    else if (pattern[i] === '*') { tokens.push({ type: 'star', value: '*' }); i++; }
  }
  return tokens;
}

function angleToNode(content: string): PatternNode {
  // <gabarit:nom> / <verbe:groupe> / <verbe:groupe#capture> / <enum:table> / <enum:table#capture>
  const colonIdx = content.indexOf(':');
  if (colonIdx > -1) {
    const prefix = content.slice(0, colonIdx);
    const rest = content.slice(colonIdx + 1);
    if (prefix === 'gabarit') return { kind: 'gabaritRef', name: rest };
    const hashIdx = rest.indexOf('#');
    const table = hashIdx > -1 ? rest.slice(0, hashIdx) : rest;
    const captureName = hashIdx > -1 ? rest.slice(hashIdx + 1) : (prefix === 'verbe' ? 'verbe' : rest);
    return { kind: 'enum', source: prefix === 'verbe' ? 'verbe' : 'enum', table, captureName };
  }
  // <categorie#capture> (renomme une capture terminale dupliquée) / <categorie>
  const hashIdx = content.indexOf('#');
  const category = hashIdx > -1 ? content.slice(0, hashIdx) : content;
  const captureName = hashIdx > -1 ? content.slice(hashIdx + 1) : content;
  if (!TERMINAL_CATEGORIES.has(category)) {
    throw new Error(`Catégorie DSL inconnue: <${content}>`);
  }
  return { kind: 'category', category, captureName };
}

class DslParser {
  private pos = 0;
  constructor(private readonly tokens: DslToken[]) {}

  private peek(): DslToken | undefined { return this.tokens[this.pos]; }
  private next(): DslToken { const t = this.tokens[this.pos]; this.pos++; return t; }

  parseSequence(stopAt: 'rparen' | 'end'): PatternNode {
    const items: PatternNode[] = [];
    while (this.peek() && !(stopAt === 'rparen' && (this.peek()!.type === 'rparen' || this.peek()!.type === 'pipe'))) {
      items.push(this.parseItem());
    }
    if (items.length === 1) return items[0];
    return { kind: 'sequence', items };
  }

  parseItem(): PatternNode {
    let node: PatternNode;
    const t = this.next();
    if (t.type === 'word') {
      node = { kind: 'literal', word: t.value };
    } else if (t.type === 'angle') {
      node = angleToNode(t.value);
    } else if (t.type === 'lparen') {
      node = this.parseAlternation();
      const close = this.next();
      if (close.type !== 'rparen') throw new Error('DSL invalide : parenthèse fermante attendue');
    } else {
      throw new Error(`DSL invalide : jeton inattendu "${t.value}"`);
    }
    const suffix = this.peek();
    if (suffix?.type === 'question') { this.next(); node = { kind: 'optional', inner: node }; }
    else if (suffix?.type === 'star') { this.next(); node = { kind: 'repeat', inner: node }; }
    return node;
  }

  parseAlternation(): PatternNode {
    const options = [this.parseSequence('rparen')];
    while (this.peek()?.type === 'pipe') {
      this.next();
      options.push(this.parseSequence('rparen'));
    }
    return options.length === 1 ? options[0] : { kind: 'alternation', options };
  }
}

const compileCache = new Map<string, PatternNode>();

export function compilePattern(pattern: string): PatternNode {
  const cached = compileCache.get(pattern);
  if (cached) return cached;
  const tokens = tokenizeDsl(pattern);
  const parser = new DslParser(tokens);
  const node = parser.parseSequence('end');
  compileCache.set(pattern, node);
  return node;
}
