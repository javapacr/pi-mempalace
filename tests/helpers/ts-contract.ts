/**
 * Formatting-tolerant reader for the pi-handoff contract (W3.R2).
 *
 * The drift test compares pi-mempalace's mirror of the pi-handoff bus
 * contract with pi-handoff's TypeScript source. The repos share no types,
 * so the source is read as text — but as declarations, not as a fixed
 * layout: comments are stripped and whitespace collapsed, union members
 * compare as sets, interface members as a name → {optional, type} map
 * (member order and `readonly` are irrelevant), and string literals may use
 * any quote style. Source comes from a committed ref (`git show`), never
 * from the working tree, so uncommitted edits in the sibling checkout
 * cannot make the test pass or fail.
 */

import { execFileSync } from "node:child_process";

/** A file's content at `ref` in the git repo at `dir`, or null when the
 * repo, the ref or the path is missing. */
export function readCommitted(dir: string, ref: string, rel: string): string | null {
	try {
		return execFileSync("git", ["-C", dir, "show", `${ref}:${rel}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

/** Strip `//` and `/* *\/` comments, keeping string and template literals
 * intact, then collapse every whitespace run to one space. */
export function normalizeSource(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (c === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 2;
			out += " ";
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			let j = i + 1;
			while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
			out += src.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		out += c;
		i++;
	}
	return out.replace(/\s+/g, " ").trim();
}

/** Drop the quotes from a string literal (any quote style); null if `s`
 * is not one. */
function unquote(s: string): string | null {
	const m = /^(["'`])(.*)\1$/.exec(s.trim());
	return m ? m[2] : null;
}

/** Split `body` on `sep` at bracket depth 0 (`{}`, `()`, `<>`, `[]`),
 * ignoring separators inside string literals. Empty parts are dropped. */
function splitTopLevel(body: string, seps: ReadonlyArray<string>): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	let quote: string | null = null;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (quote) {
			cur += c;
			if (c === "\\") {
				cur += body[++i] ?? "";
			} else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			quote = c;
			cur += c;
			continue;
		}
		// `=>` is an arrow, not a closing angle bracket.
		if (c === ">" && body[i - 1] === "=") {
			cur += c;
			continue;
		}
		if ("{([<".includes(c)) depth++;
		if ("})]>".includes(c)) depth--;
		if (depth === 0 && seps.includes(c)) {
			if (cur.trim()) parts.push(cur.trim());
			cur = "";
			continue;
		}
		cur += c;
	}
	if (cur.trim()) parts.push(cur.trim());
	return parts;
}

/** The text between the brace that opens at or after `from` and its
 * matching close, or null. */
function bracedBody(src: string, from: number): string | null {
	const open = src.indexOf("{", from);
	if (open === -1) return null;
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
	}
	return null;
}

/** A type written canonically: whitespace removed, quotes normalised to
 * `"`, and top-level union members sorted, so `null | string` equals
 * `string|null`. */
export function canonicalType(type: string): string {
	const members = splitTopLevel(type.replace(/^\s*\|/, ""), ["|"]).map((m) => {
		const lit = unquote(m);
		return lit !== null ? JSON.stringify(lit) : m.replace(/\s+/g, "");
	});
	return members.sort().join("|");
}

/** Members of `type <name> = A | B | …` as a set of canonical members
 * (string literals unquoted), or null when the alias is absent. */
export function unionMembers(src: string, name: string): Set<string> | null {
	const norm = normalizeSource(src);
	const m = new RegExp(`\\btype ${name}\\s*=\\s*([^;]+);`).exec(norm);
	if (!m) return null;
	return new Set(
		splitTopLevel(m[1].replace(/^\s*\|/, ""), ["|"]).map(
			(part) => unquote(part) ?? part.replace(/\s+/g, ""),
		),
	);
}

export interface MemberShape {
	readonly optional: boolean;
	readonly type: string;
}

/** Members of `interface <name> … { … }` keyed by name, or null when the
 * interface is absent. Types are canonical (see canonicalType). */
export function interfaceMembers(
	src: string,
	name: string,
): Map<string, MemberShape> | null {
	const norm = normalizeSource(src);
	const m = new RegExp(`\\binterface ${name}\\b`).exec(norm);
	if (!m) return null;
	const body = bracedBody(norm, m.index);
	if (body === null) return null;
	const members = new Map<string, MemberShape>();
	for (const part of splitTopLevel(body, [";", ","])) {
		const decl = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\?)?\s*:\s*([\s\S]+)$/.exec(part);
		if (!decl) continue;
		members.set(decl[1], { optional: decl[2] === "?", type: canonicalType(decl[3]) });
	}
	return members;
}

/** Key → string value of `const <name> = { key: "v", … }` (an `as const`
 * suffix and any quote style allowed), or null when absent. */
export function stringObject(src: string, name: string): Map<string, string> | null {
	const norm = normalizeSource(src);
	const m = new RegExp(`\\bconst ${name}\\b[^=]*=`).exec(norm);
	if (!m) return null;
	const body = bracedBody(norm, m.index);
	if (body === null) return null;
	const out = new Map<string, string>();
	for (const part of splitTopLevel(body, [","])) {
		const kv = /^(["'`]?)([\w$]+)\1\s*:\s*(.+)$/.exec(part);
		const value = kv ? unquote(kv[3]) : null;
		if (kv && value !== null) out.set(kv[2], value);
	}
	return out;
}

/** The numeric value of `const <name>[: number] = 120_000;`, or null. */
export function numericConst(src: string, name: string): number | null {
	const m = new RegExp(
		`\\bconst ${name}\\s*(?::\\s*number\\s*)?=\\s*([\\d_]+(?:\\.\\d+)?)\\s*;`,
	).exec(normalizeSource(src));
	return m ? Number(m[1].replace(/_/g, "")) : null;
}
