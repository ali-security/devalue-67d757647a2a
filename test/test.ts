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

		it('preallocates short repeated arrays', () => {
			const arr: any[] = [];
			arr[33] = 'x';
			assert.equal(devalue([arr, arr]), `(function(a){a[33]="x";return [a,a]}(Array(34)))`);

			arr.length = 35;
			assert.equal(devalue([arr, arr]), `(function(a){a[33]="x";return [a,a]}(${sparse(35)}))`);
		});

		// Arrays that are not repeated are emitted as array literals, so only
		// the repeated ('empty', 'shared') and cyclic encodings are exercised
		['empty', 'shared', 'cyclic'].forEach(kind => {
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

				const js = devalue(kind === 'cyclic' ? proxy : [proxy, proxy]);
				assert.ok(js.length < 150, `sparse output should stay compact: ${js}`);
				const result = evaluate(js);
				const restored = kind === 'cyclic' ? result : result[0];

				assert.equal(restored.length, length);
				assert.deepEqual(Object.keys(restored), kind === 'empty' ? [] : [String(index)]);
				if (kind !== 'empty') {
					assert.ok(restored[index] === (kind === 'cyclic' ? restored : 42));
				}
				if (kind !== 'cyclic') assert.ok(result[0] === result[1]);
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

		// Arrays that are not repeated are emitted as array literals, so every
		// kind here goes through the repeated ('shared', 'holes') or cyclic encoding
		['shared', 'cyclic', 'holes'].forEach(kind => {
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

				const shared = kind !== 'cyclic';
				const js = devalue(shared ? [arrays, arrays.slice()] : arrays);
				const result = evaluate(js);
				const restored = shared ? result[0] : result;
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
					if (shared) assert.ok(result[0][i] === result[1][i]);
				});
			});
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
