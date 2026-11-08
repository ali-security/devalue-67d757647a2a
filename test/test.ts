import * as assert from 'assert';
import * as vm from 'vm';
import devalue from '../src/index';

describe('devalue', () => {
	function test(name: string, input: any, expected: string) {
		it(name, () => {
			const actual = devalue(input);
			assert.equal(actual, expected);
		});
	}

	describe('basics', () => {
		test('number', 42, '42');
		test('negative number', -42, '-42');
		test('negative zero', -0, '-0');
		test('positive decimal', 0.1, '.1');
		test('negative decimal', -0.1, '-.1');
		test('string', 'woo!!!', '"woo!!!"');
		test('boolean', true, 'true');
		test('Number', new Number(42), 'Object(42)');
		test('String', new String('yar'), 'Object("yar")');
		test('Boolean', new Boolean(false), 'Object(false)');
		test('undefined', undefined, 'void 0');
		test('null', null, 'null');
		test('NaN', NaN, 'NaN');
		test('Infinity', Infinity, 'Infinity');
		test('RegExp', /regexp/img, 'new RegExp("regexp", "gim")');
		test('Date', new Date(1e12), 'new Date(1000000000000)');
		test('Array', ['a', 'b', 'c'], '["a","b","c"]');
		test('Array (empty)', [], '[]');
		test('Array (sparse)', [,'b',,], '[,"b",,]');
		test('Array (very sparse)', ((arr: any[]) => {
			arr[1000000] = 'x';
			return arr;
		})([]), 'Object.assign((function(a){a[4294967294]=0;delete a[4294967294];a.length=1000001;return a}([])),{1000000:"x"})');
		test('Array (very sparse, multiple values)', ((arr: any[]) => {
			arr[10] = 'a';
			arr[20] = 'b';
			return arr;
		})([]), '[,,,,,,,,,,"a",,,,,,,,,,"b"]');
		test('Object', {foo: 'bar', 'x-y': 'z'}, '{foo:"bar","x-y":"z"}');
		test('Set', new Set([1, 2, 3]), 'new Set([1,2,3])');
		test('Map', new Map([['a', 'b']]), 'new Map([["a","b"]])');
	});

	describe('strings', () => {
		test('newline', 'a\nb', JSON.stringify('a\nb'));
		test('double quotes', '"yar"', JSON.stringify('"yar"'));
		test('lone low surrogate', "a\uDC00b", '"a\\uDC00b"');
		test('lone high surrogate', "a\uD800b", '"a\\uD800b"');
		test('two low surrogates', "a\uDC00\uDC00b", '"a\\uDC00\\uDC00b"');
		test('two high surrogates', "a\uD800\uD800b", '"a\\uD800\\uD800b"');
		test('surrogate pair', '𝌆', JSON.stringify('𝌆'));
		test('surrogate pair in wrong order', 'a\uDC00\uD800b', '"a\\uDC00\\uD800b"');
		test('nul', '\0', '"\\0"');
		test('backslash', '\\', JSON.stringify('\\'));
	});

	describe('cycles', () => {
		let map = new Map();
		map.set('self', map);
		test('Map (cyclical)', map, `(function(a){a.set("self", a);return a}(new Map))`);

		let set = new Set();
		set.add(set);
		set.add(42);
		test('Set (cyclical)', set, `(function(a){a.add(a).add(42);return a}(new Set))`);

		let arr: any[] = [];
		arr[0] = arr;
		test('Array (cyclical)', arr, `(function(a){a[0]=a;return a}(Array(1)))`);

		let obj: any = {};
		obj.self = obj;
		test('Object (cyclical)', obj, `(function(a){a.self=a;return a}({}))`);

		let objFromNull: any = Object.create(null);
		objFromNull.self = objFromNull;
		test('Object (cyclical)', objFromNull, `(function(a){a.self=a;return a}(Object.create(null)))`);

		let first: any = {};
		let second: any = {};
		first.second = second;
		second.first = first;
		test('Object (cyclical)', [first, second], `(function(a,b){a.second=b;b.first=a;return [a,b]}({},{}))`);
	});

	describe('repetition', () => {
		let str = 'a string';
		test('String (repetition)', [str, str], `(function(a){return [a,a]}("a string"))`);
	});

	describe('repeated primitives', () => {
		function evaluate(js: string): any {
			return vm.runInThisContext(`(${js})`);
		}

		const primitives: Array<[string, (n: number) => string]> = [
			['string', n => 'x'.repeat(n)],
			['escaped string', n => '</script>\n"\\\0\u2028\u2029'.repeat(n)]
		];

		primitives.forEach(([name, makePrimitive]) => {
			it(`${name} output grows linearly when repeated`, () => {
				let previousLength = 0;

				[2000, 4000].forEach(n => {
					const primitive = makePrimitive(n);
					// a compact encoding of the same value references a single copy of the primitive
					const encoded = JSON.stringify([Array(n).fill(1), primitive]);
					const value = Array(n).fill(primitive);
					const serialized = devalue(value);

					assert.ok(serialized.length < encoded.length * 4, `output too large: ${serialized.length}`);
					if (previousLength) assert.ok(serialized.length < previousLength * 2.1);
					previousLength = serialized.length;

					assert.deepStrictEqual(evaluate(serialized), value);
					assert.ok(serialized.indexOf('<') === -1);
				});
			});

			it(`${name} shared by distinct boxes stays compact`, () => {
				const n = 2000;
				const primitive = makePrimitive(n);
				const value = Array.from({ length: n }, () => Object(primitive));
				const serialized = devalue(value);

				// a compact encoding stores the primitive once, plus a bounded cost per box
				const encoded = JSON.stringify(primitive).length + 16 * n;
				assert.ok(serialized.length < encoded * 4, `output too large: ${serialized.length}`);
				assert.ok(serialized.indexOf('<') === -1);

				const result = evaluate(serialized);
				assert.equal(result.length, n);
				assert.equal(new Set(result).size, n);
				result.forEach((box: any) => {
					assert.equal(typeof box, 'object');
					assert.strictEqual(box.valueOf(), primitive);
				});
			});

			it(`${name} preserves shared and distinct box identities`, () => {
				const primitive = makePrimitive(256);
				const box = Object(primitive);
				const value = [box, box, primitive, primitive, Object(primitive)];
				const result = evaluate(devalue(value));

				assert.ok(result[0] === result[1]);
				assert.equal(typeof result[0], 'object');
				assert.strictEqual(result[0].valueOf(), primitive);
				assert.strictEqual(result[2], primitive);
				assert.strictEqual(result[3], primitive);
				assert.equal(typeof result[4], 'object');
				assert.strictEqual(result[4].valueOf(), primitive);
				assert.equal(new Set([result[0], result[4]]).size, 2);
			});

			it(`${name} round-trips in shared and cyclic containers`, () => {
				const primitive = makePrimitive(256);
				const array = [primitive];
				const map = new Map([[primitive, primitive]]);
				const set = new Set([primitive]);
				const box = Object(primitive);
				const sparse: any[] = [];
				sparse[1000] = primitive;
				const value: any = Object.assign(Object.create(null), {
					primitive,
					array,
					array_again: array,
					map,
					map_again: map,
					set,
					set_again: set,
					box,
					box_again: box,
					sparse
				});
				value.self = value;

				const result = evaluate(devalue(value));
				assert.strictEqual(Object.getPrototypeOf(result), null);
				assert.ok(result.self === result);
				assert.strictEqual(result.primitive, primitive);
				assert.ok(result.array === result.array_again);
				assert.strictEqual(result.array[0], primitive);
				assert.ok(result.map === result.map_again);
				assert.strictEqual(result.map.get(primitive), primitive);
				assert.ok(result.set === result.set_again);
				assert.ok(result.set.has(primitive));
				assert.ok(result.box === result.box_again);
				assert.strictEqual(result.box.valueOf(), primitive);
				assert.deepStrictEqual(result.sparse, sparse);
			});
		});

		it('keeps repeated short strings compact', () => {
			const value = Array(1000).fill('pending');
			const serialized = devalue(value);

			assert.ok(serialized.length <= JSON.stringify(value).length);
			assert.deepStrictEqual(evaluate(serialized), value);
		});

		it('bounds expansion of repeated strings around 128 characters', () => {
			[127, 128, 129].forEach(length => {
				['x', '<'].forEach(character => {
					const value = Array(2000).fill(character.repeat(length));
					const serialized = devalue(value);

					assert.deepStrictEqual(evaluate(serialized), value);
					assert.ok(serialized.indexOf('<') === -1);
					assert.ok(serialized.length < 6 * length + 3 * value.length);
				});
			});
		});

		it('preserves other primitives alongside hoisted values', () => {
			const text = 'x'.repeat(256);
			// 0 and -0 are deliberately not mixed here: repeated numbers are
			// hoisted by SameValueZero, which is independent of this fix
			const value = [
				text,
				text,
				-0,
				NaN,
				NaN,
				Infinity,
				Infinity,
				-Infinity,
				-Infinity,
				undefined,
				undefined,
				null,
				null,
				true,
				true,
				false,
				false
			];
			const result = evaluate(devalue(value));

			assert.equal(result.length, value.length);
			for (let i = 0; i < value.length; i += 1) {
				assert.ok(Object.is(result[i], value[i]), `mismatch at index ${i}`);
			}
		});
	});

	describe('sparse arrays', () => {
		// the largest valid array index, i.e. an array of length 2 ** 32 - 1
		const MAX_INDEX = 4294967294;

		function evaluate(js: string): any {
			return vm.runInThisContext(`(${js})`);
		}

		// the expression devalue emits to allocate a sparse array without
		// eagerly allocating storage proportional to its length
		function sparse(length: number) {
			return `(function(a){a[${MAX_INDEX}]=0;delete a[${MAX_INDEX}];a.length=${length};return a}([]))`;
		}

		it('round-trips very sparse arrays', () => {
			const arr: any[] = [];
			arr[1000000] = 'x';

			const value = evaluate(devalue(arr));
			assert.equal(value.length, 1000001);
			assert.equal(value[1000000], 'x');
			assert.ok(!(0 in value));
			assert.ok(!(999999 in value));
		});

		it('round-trips very sparse arrays with multiple values', () => {
			const arr: any[] = [];
			arr[10] = 'a';
			arr[20] = 'b';

			const value = evaluate(devalue(arr));
			assert.equal(value.length, 21);
			assert.equal(value[10], 'a');
			assert.equal(value[20], 'b');
			assert.ok(!(0 in value));
			assert.ok(!(9 in value));
			assert.ok(!(11 in value));
		});

		it('handles very sparse arrays efficiently', () => {
			const arr: any[] = [];
			arr[MAX_INDEX] = 'x';

			// This should complete nearly instantly, not iterate 4 billion times
			const start = Date.now();
			const js = devalue(arr);
			const elapsed = Date.now() - start;

			assert.ok(elapsed < 1000, `devalue took ${elapsed}ms, expected < 1000ms`);
			assert.equal(js, `Object.assign(${sparse(MAX_INDEX + 1)},{${MAX_INDEX}:"x"})`);

			// Verify round-trip
			const value = evaluate(js);
			assert.equal(value.length, MAX_INDEX + 1);
			assert.equal(value[MAX_INDEX], 'x');
			assert.ok(!(0 in value));
		});

		it('handles repeated very sparse arrays efficiently', () => {
			const arr: any[] = [];
			arr[MAX_INDEX] = 'x';

			const start = Date.now();
			const js = devalue([arr, arr]);
			const elapsed = Date.now() - start;

			assert.ok(elapsed < 1000, `devalue took ${elapsed}ms, expected < 1000ms`);
			assert.equal(js, `(function(a){a[${MAX_INDEX}]="x";return [a,a]}(${sparse(MAX_INDEX + 1)}))`);

			const value = evaluate(js);
			assert.equal(value[0], value[1]);
			assert.equal(value[0].length, MAX_INDEX + 1);
			assert.equal(value[0][MAX_INDEX], 'x');
			assert.ok(!(0 in value[0]));
		});

		it('handles cyclical very sparse arrays efficiently', () => {
			const arr: any[] = [];
			arr[MAX_INDEX] = arr;

			const start = Date.now();
			const js = devalue(arr);
			const elapsed = Date.now() - start;

			assert.ok(elapsed < 1000, `devalue took ${elapsed}ms, expected < 1000ms`);
			assert.equal(js, `(function(a){a[${MAX_INDEX}]=a;return a}(${sparse(MAX_INDEX + 1)}))`);

			const value = evaluate(js);
			assert.equal(value.length, MAX_INDEX + 1);
			assert.equal(value[MAX_INDEX], value);
			assert.ok(!(0 in value));
		});

		it('handles very sparse arrays nested in objects efficiently', () => {
			const arr: any[] = [];
			arr[MAX_INDEX] = { foo: 'bar' };

			const start = Date.now();
			const js = devalue({ arr });
			const elapsed = Date.now() - start;

			assert.ok(elapsed < 1000, `devalue took ${elapsed}ms, expected < 1000ms`);
			assert.equal(js, `{arr:Object.assign(${sparse(MAX_INDEX + 1)},{${MAX_INDEX}:{foo:"bar"}})}`);
		});

		it('preallocates short repeated arrays', () => {
			const arr: any[] = [];
			arr[33] = 'x';
			assert.equal(devalue([arr, arr]), `(function(a){a[33]="x";return [a,a]}(Array(34)))`);

			arr.length = 35;
			assert.equal(devalue([arr, arr]), `(function(a){a[33]="x";return [a,a]}(${sparse(35)}))`);
		});

		['empty', 'single', 'shared', 'cyclic'].forEach(kind => {
			it(`does not scan sparse array holes (${kind})`, () => {
				const length = 2 ** 32 - 1;
				const index = length - 1;
				const array: any[] = [];
				array[index] = 42;
				if (kind === 'empty') delete array[index];

				// Count property probes rather than relying on wall-clock timings. This
				// also bounds the work if either traversal regresses to scanning holes.
				let probes = 0;
				function probe() {
					assert.ok(++probes <= 100, 'devalue should only inspect populated indices');
				}

				const proxy = new Proxy(array, {
					get(target, key, receiver) {
						probe();
						return Reflect.get(target, key, receiver);
					},
					has(target, key) {
						probe();
						return Reflect.has(target, key);
					},
					getOwnPropertyDescriptor(target, key) {
						probe();
						return Reflect.getOwnPropertyDescriptor(target, key);
					}
				});

				if (kind === 'cyclic') array[index] = proxy;

				const js = devalue(kind === 'shared' ? [proxy, proxy] : proxy);
				assert.ok(js.length < 150, `sparse output should stay compact: ${js}`);
				const result = evaluate(js);
				const restored = kind === 'shared' ? result[0] : result;

				assert.equal(restored.length, length);
				assert.deepEqual(Object.keys(restored), kind === 'empty' ? [] : [String(index)]);
				if (kind !== 'empty') {
					assert.ok(restored[index] === (kind === 'cyclic' ? restored : 42));
				}
				if (kind === 'shared') assert.ok(result[0] === result[1]);
			});
		});

		[3, 1000].forEach(length => {
			[false, true].forEach(shared => {
				it(`ignores inherited array elements (length=${length}, shared=${shared})`, () => {
					const proto = Object.create(Array.prototype);
					[1, length - 1].forEach(index => {
						Object.defineProperty(proto, String(index), {
							enumerable: index === 1,
							get() {
								throw new Error('inherited array elements should not be read');
							}
						});
					});
					const array: any[] = [42];
					array.length = length;
					Object.setPrototypeOf(array, proto);

					const result = evaluate(devalue(shared ? [array, array] : array));
					const restored = shared ? result[0] : result;
					assert.equal(restored.length, length);
					assert.deepEqual(Object.keys(restored), ['0']);
					assert.equal(restored[0], 42);
					if (shared) assert.ok(result[0] === result[1]);
				});
			});
		});

		it('ignores non-index properties on shared arrays', () => {
			const array: any[] = [42];
			const keys: any[] = ['foo', '-1', '01', '1e0', '1.5', '4294967295', Symbol('key')];
			keys.forEach(key => {
				Object.defineProperty(array, key, {
					enumerable: true,
					get() {
						throw new Error('non-index array properties should not be read');
					}
				});
			});

			const result = evaluate(devalue([array, array]));
			assert.deepEqual(result, [[42], [42]]);
			assert.ok(result[0] === result[1]);
		});

		it('throws for invalid sparse array elements', () => {
			const array: any[] = [];
			array[99999999] = () => {};
			const root = { array };

			assert.throws(() => devalue(root), /Cannot stringify a function/);
		});

		['inline', 'shared', 'cyclic', 'holes'].forEach(kind => {
			it(`evaluates ${kind} sparse arrays without eager allocation`, () => {
				// Eager allocation of 2500 arrays of length 1000000 would require ~20GB.
				const length = 1000000;
				const arrays: any[][] = [];
				for (let i = 0; i < 2500; i += 1) {
					// build the input without eagerly allocating it either: touching
					// and deleting the largest valid index forces dictionary elements
					const array: any[] = [];
					array[MAX_INDEX] = 0;
					delete array[MAX_INDEX];
					array.length = length;
					array[0] = 42;

					if (kind === 'holes') {
						delete array[0];
					} else {
						array[1] = kind === 'cyclic' ? array : undefined;
					}

					arrays.push(array);
				}

				const js = devalue(kind === 'shared' ? [arrays, arrays.slice()] : arrays);
				const result = evaluate(js);
				const restored = kind === 'shared' ? result[0] : result;
				assert.equal(restored.length, arrays.length);

				[0, arrays.length - 1].forEach(i => {
					const array = restored[i];
					assert.ok(array instanceof Array);
					assert.equal(array.length, length);
					assert.deepEqual(
						Object.getOwnPropertyNames(array),
						kind === 'holes' ? ['length'] : ['0', '1', 'length']
					);
					assert.ok(!(length - 1 in array));
					if (kind !== 'holes') {
						assert.equal(array[0], 42);
						assert.ok(array[1] === (kind === 'cyclic' ? array : undefined));
					}
					if (kind === 'shared') assert.ok(result[0][i] === result[1][i]);
				});
			});
		});

		it('ignores non-numeric array properties in dense encoding', () => {
			// Dense path (few holes — array literal wins)
			const arr: any = [, 'a', , 'b'];
			arr.foo = 'should be ignored';
			arr.bar = 42;

			// should produce the holey literal, no mention of "foo" or "bar"
			const js = devalue(arr);
			assert.ok(js.indexOf('foo') === -1, `devalue output should not contain "foo": ${js}`);
			assert.ok(js.indexOf('bar') === -1, `devalue output should not contain "bar": ${js}`);
			assert.ok(js.indexOf('should be ignored') === -1, `devalue output should not contain non-numeric value: ${js}`);
			const value = evaluate(js);
			assert.equal(value.length, 4);
			assert.equal(value[1], 'a');
			assert.equal(value[3], 'b');
			assert.ok(!(0 in value));
		});

		it('ignores non-numeric array properties in sparse encoding', () => {
			// Sparse path (very sparse — Object.assign wins)
			const arr: any = [];
			arr[1000000] = 'x';
			arr.foo = 'should be ignored';
			arr.bar = 42;

			// should produce Object.assign form, no mention of "foo" or "bar"
			const js = devalue(arr);
			assert.ok(js.indexOf('foo') === -1, `devalue output should not contain "foo": ${js}`);
			assert.ok(js.indexOf('bar') === -1, `devalue output should not contain "bar": ${js}`);
			assert.ok(js.indexOf('should be ignored') === -1, `devalue output should not contain non-numeric value: ${js}`);
			assert.ok(js.indexOf('Object.assign') !== -1, `devalue should use Object.assign for very sparse arrays`);
			const value = evaluate(js);
			assert.equal(value.length, 1000001);
			assert.equal(value[1000000], 'x');
			assert.ok(!(0 in value));
			assert.ok(!('foo' in value));
		});

		it('ignores array properties pretending to be indices', () => {
			const arr: any = [];
			arr[1000000] = 'x';
			arr[-1] = 'negative index';
			arr[MAX_INDEX + 1] = 'too large index';
			arr['01'] = 'leading zero';

			assert.equal(devalue(arr), `Object.assign(${sparse(1000001)},{1000000:"x"})`);
		});

		it('round-trips sparse arrays whose first hole is not at index 0', () => {
			for (const arr of [[1, , 3], [1, ,], [1, , , 4], [1, 2, , 4]]) {
				const value = evaluate(devalue(arr));
				assert.equal(value.length, arr.length, `length for keys ${Object.keys(arr).join(',')}`);
				assert.deepEqual(Object.keys(value), Object.keys(arr));
				for (const k of Object.keys(arr)) {
					assert.equal(value[k], (arr as any)[k]);
				}
			}
		});
	});

	describe('XSS', () => {
		test(
			'Dangerous string',
			`</script><script src='https://evil.com/script.js'>alert('pwned')</script><script>`,
			`"\\u003C\\u002Fscript\\u003E\\u003Cscript src='https:\\u002F\\u002Fevil.com\\u002Fscript.js'\\u003Ealert('pwned')\\u003C\\u002Fscript\\u003E\\u003Cscript\\u003E"`
		);
		test(
			'Dangerous key',
			{ '<svg onload=alert("xss_works")>': 'bar' },
			'{"\\u003Csvg onload=alert(\\"xss_works\\")\\u003E":"bar"}'
		);
		test(
			'Dangerous regex',
			/[</script><script>alert('xss')//]/,
			`new RegExp("[\\u003C\\\\\\u002Fscript\\u003E\\u003Cscript\\u003Ealert('xss')\\\\\\u002F\\\\\\u002F]", "")`
		);
	});

	describe('misc', () => {
		test('Object without prototype', Object.create(null), 'Object.create(null)');

		// let arr = [];
		// arr.x = 42;
		// test('Array with named properties', arr, `TODO`);

		test('cross-realm POJO', vm.runInNewContext('({})'), '{}');

		it('throws for non-POJOs', () => {
			class Foo {}
			const foo = new Foo();
			assert.throws(() => devalue(foo));
		});

		it('throws for symbolic keys', () => {
			assert.throws(() => devalue({ [Symbol()]: null }));
		});

		it('throws for __proto__ keys', () => {
			const inner = JSON.parse('{"__proto__":1}');
			const root = { foo: inner };
			assert.throws(
				() => devalue(root),
				(err: Error) => {
					assert.equal(err.message, 'Cannot stringify objects with __proto__ keys');
					return true;
				}
			);
		});
	});
});
