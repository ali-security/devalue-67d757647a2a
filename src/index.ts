const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const unsafeChars = /[<>\b\f\n\r\t\0\u2028\u2029]/g;
const reserved = /^(?:do|if|in|for|int|let|new|try|var|byte|case|char|else|enum|goto|long|this|void|with|await|break|catch|class|const|final|float|short|super|throw|while|yield|delete|double|export|import|native|return|switch|throws|typeof|boolean|default|extends|finally|package|private|abstract|continue|debugger|function|volatile|interface|protected|transient|implements|instanceof|synchronized)$/;
const escaped: Record<string, string> = {
	'<': '\\u003C',
	'>' : '\\u003E',
	'/': '\\u002F',
	'\\': '\\\\',
	'\b': '\\b',
	'\f': '\\f',
	'\n': '\\n',
	'\r': '\\r',
	'\t': '\\t',
	'\0': '\\0',
	'\u2028': '\\u2028',
	'\u2029': '\\u2029'
};
const objectProtoOwnPropertyNames = Object.getOwnPropertyNames(Object.prototype).sort().join('\0');

export default function devalue(value: any) {
	const counts = new Map();

	function walk(thing: any) {
		if (typeof thing === 'function') {
			throw new Error(`Cannot stringify a function`);
		}

		if (counts.has(thing)) {
			counts.set(thing, counts.get(thing) + 1);
			return;
		}

		counts.set(thing, 1);

		if (!isPrimitive(thing)) {
			const type = getType(thing);

			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
				case 'Date':
				case 'RegExp':
					return;

				case 'Array':
					// Only visit populated indices — Array.prototype.forEach checks
					// every slot up to thing.length, which is what makes very
					// sparse arrays (e.g. `arr[1000000] = 1`) expensive to walk
					validArrayIndices(thing).forEach(i => walk(thing[i]));
					break;

				case 'Set':
				case 'Map':
					Array.from(thing).forEach(walk);
					break;

				default:
					const proto = Object.getPrototypeOf(thing);

					if (
						proto !== Object.prototype &&
						proto !== null &&
						Object.getOwnPropertyNames(proto).sort().join('\0') !== objectProtoOwnPropertyNames
					) {
						throw new Error(`Cannot stringify arbitrary non-POJOs`);
					}

					if (Object.getOwnPropertySymbols(thing).length > 0) {
						throw new Error(`Cannot stringify POJOs with symbolic keys`);
					}

					Object.keys(thing).forEach(key => {
						if (key === '__proto__') {
							throw new Error(`Cannot stringify objects with __proto__ keys`);
						}
						walk(thing[key]);
					});
			}
		}
	}

	walk(value);

	const names = new Map();

	Array.from(counts)
		.filter(entry => entry[1] > 1)
		.sort((a, b) => b[1] - a[1])
		.forEach((entry, i) => {
			names.set(entry[0], getName(i));
		});

	function stringify(thing: any): string {
		if (names.has(thing)) {
			return names.get(thing);
		}

		if (isPrimitive(thing)) {
			return stringifyPrimitive(thing);
		}

		const type = getType(thing);

		switch (type) {
			case 'Number':
			case 'String':
			case 'Boolean':
				return `Object(${stringify(thing.valueOf())})`;

			case 'RegExp':
				return `new RegExp(${stringifyString(thing.source)}, "${thing.flags}")`;

			case 'Date':
				return `new Date(${thing.getTime()})`;

			case 'Array':
				// Only own elements are emitted, matching what walk() visits —
				// inherited array elements are neither read nor serialized
				const members: string[] = [];
				for (let i = 0; i < thing.length; i += 1) {
					members.push(Object.prototype.hasOwnProperty.call(thing, i) ? stringify(thing[i]) : '');
				}
				const tail = thing.length === 0 || Object.prototype.hasOwnProperty.call(thing, thing.length - 1) ? '' : ',';
				return `[${members.join(',')}${tail}]`;

			case 'Set':
			case 'Map':
				return `new ${type}([${Array.from(thing).map(stringify).join(',')}])`;

			default:
				const obj = `{${Object.keys(thing).map(key => `${safeKey(key)}:${stringify(thing[key])}`).join(',')}}`;
				const proto = Object.getPrototypeOf(thing);
				if (proto === null) {
					return Object.keys(thing).length > 0
						? `Object.assign(Object.create(null),${obj})`
						: `Object.create(null)`;
				}

				return obj;
		}
	}

	const str = stringify(value);

	if (names.size) {
		const params: string[] = [];
		const statements: string[] = [];
		const values: string[] = [];

		names.forEach((name, thing) => {
			params.push(name);

			if (isPrimitive(thing)) {
				values.push(stringifyPrimitive(thing));
				return;
			}

			const type = getType(thing);

			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
					values.push(`Object(${stringify(thing.valueOf())})`);
					break;

				case 'RegExp':
					values.push(thing.toString());
					break;

				case 'Date':
					values.push(`new Date(${thing.getTime()})`);
					break;

				case 'Array': {
					const populatedKeys = validArrayIndices(thing);
					// Only preallocate when the length is bounded by the number
					// of populated elements, plus a small constant for short arrays.
					values.push(
						thing.length > 32 + 2 * populatedKeys.length
							? stringifySparseArray(thing.length)
							: `Array(${thing.length})`
					);
					// Only visit populated indices, so that very sparse arrays
					// don't cost time proportional to thing.length
					populatedKeys.forEach(i => {
						statements.push(`${name}[${i}]=${stringify(thing[i])}`);
					});
					break;
				}

				case 'Set':
					values.push(`new Set`);
					statements.push(`${name}.${Array.from(thing).map(v => `add(${stringify(v)})`).join('.')}`);
					break;

				case 'Map':
					values.push(`new Map`);
					statements.push(`${name}.${Array.from(thing).map(([k, v]) => `set(${stringify(k)}, ${stringify(v)})`).join('.')}`);
					break;

				default:
					values.push(Object.getPrototypeOf(thing) === null ? 'Object.create(null)' : '{}');
					Object.keys(thing).forEach(key => {
						statements.push(`${name}${safeProp(key)}=${stringify(thing[key])}`);
					});
			}
		});

		statements.push(`return ${str}`);

		return `(function(${params.join(',')}){${statements.join(';')}}(${values.join(',')}))`
	} else {
		return str;
	}
}

function getName(num: number) {
	let name = '';

	do {
		name = chars[num % chars.length] + name;
		num = ~~(num / chars.length) - 1;
	} while (num >= 0);

	return reserved.test(name) ? `${name}_` : name;
}

function isPrimitive(thing: any) {
	return Object(thing) !== thing;
}

function stringifyPrimitive(thing: any) {
	if (typeof thing === 'string') return stringifyString(thing);
	if (thing === void 0) return 'void 0';
	if (thing === 0 && 1 / thing < 0) return '-0';
	const str = String(thing);
	if (typeof thing === 'number') return str.replace(/^(-)?0\./, '$1.');
	return str;
}

function getType(thing: any) {
	return Object.prototype.toString.call(thing).slice(8, -1);
}

function isValidArrayIndex(s: string) {
	if (s.length === 0) return false;
	if (s.length > 1 && s.charCodeAt(0) === 48) return false; // leading zero
	for (let i = 0; i < s.length; i += 1) {
		const c = s.charCodeAt(i);
		if (c < 48 || c > 57) return false;
	}
	// by this point we know it's a string of digits, but it has to be within the range of valid array indices
	const n = +s;
	if (n >= 4294967295) return false; // 2 ** 32 - 1
	if (n < 0) return false;
	return true;
}

// Finds the populated indices of an array. Object.keys lists the
// array indices first (in ascending order), followed by any
// non-numeric properties, which are stripped from the result
function validArrayIndices(array: any[]) {
	const keys = Object.keys(array);
	let i = keys.length - 1;
	for (; i >= 0; i -= 1) {
		if (isValidArrayIndex(keys[i])) {
			break;
		}
	}
	keys.length = i + 1;
	return keys;
}

// the largest valid array index, i.e. 2 ** 32 - 2
const MAX_ARRAY_INDEX = 4294967294;

/**
 * Emit an array whose storage is not proportional to its declared length.
 * Touching and deleting the largest valid index forces V8 into
 * dictionary-elements mode before setting the length.
 * Merely starting with [] and assigning .length still eagerly allocates.
 */
function stringifySparseArray(length: number) {
	return `(function(a){a[${MAX_ARRAY_INDEX}]=0;delete a[${MAX_ARRAY_INDEX}];a.length=${length};return a}([]))`;
}

function escapeUnsafeChar(c: string) {
	return escaped[c] || c
}

function escapeUnsafeChars(str: string) {
	return str.replace(unsafeChars, escapeUnsafeChar)
}

function safeKey(key: string) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key) ? key : escapeUnsafeChars(JSON.stringify(key));
}

function safeProp(key: string) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key) ? `.${key}` : `[${escapeUnsafeChars(JSON.stringify(key))}]`;
}

function stringifyString(str: string) {
	let result = '"';

	for (let i = 0; i < str.length; i += 1) {
		const char = str.charAt(i);
		const code = char.charCodeAt(0);

		if (char === '"') {
			result += '\\"';
		} else if (char in escaped) {
			result += escaped[char];
		} else if (code >= 0xd800 && code <= 0xdfff) {
			const next = str.charCodeAt(i + 1);

			// If this is the beginning of a [high, low] surrogate pair,
			// add the next two characters, otherwise escape
			if (code <= 0xdbff && (next >= 0xdc00 && next <= 0xdfff)) {
				result += char + str[++i];
			} else {
				result += `\\u${code.toString(16).toUpperCase()}`;
			}
		} else {
			result += char;
		}
	}

	result += '"';
	return result;
}
