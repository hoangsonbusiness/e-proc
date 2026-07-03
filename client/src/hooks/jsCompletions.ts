import type * as Monaco from 'monaco-editor';

function snip(
  monaco: typeof Monaco,
  label: string,
  insertText: string,
  detail: string,
  documentation: string
): Monaco.languages.CompletionItem {
  return {
    label,
    kind: monaco.languages.CompletionItemKind.Snippet,
    detail,
    documentation: { value: documentation, isTrusted: true },
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  };
}

// ─── JS DOM Snippets ────────────────────────────────────────────────────────

function getJsDomSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    snip(monaco, 'qsel', 'document.querySelector(\'${1:#id}\');', 'querySelector', 'document.querySelector() — select first matching element'),
    snip(monaco, 'qsel-all', 'document.querySelectorAll(\'${1:.class}\');', 'querySelectorAll', 'document.querySelectorAll() — select all matching elements'),
    snip(monaco, 'getById', 'document.getElementById(\'${1:myId}\');', 'getElementById', 'document.getElementById()'),
    snip(monaco, 'getByClass', 'document.getElementsByClassName(\'${1:myClass}\');', 'getElementsByClassName', 'document.getElementsByClassName()'),
    snip(monaco, 'getByTag', 'document.getElementsByTagName(\'${1:div}\');', 'getElementsByTagName', 'document.getElementsByTagName()'),
    snip(monaco, 'createElement',
      'const ${1:el} = document.createElement(\'${2:div}\');\n${1:el}.className = \'${3:my-class}\';\n${1:el}.textContent = \'${4:text}\';\ndocument.getElementById(\'${5:container}\').appendChild(${1:el});',
      'createElement', 'Create and append a new DOM element'),
    snip(monaco, 'innerHTML', '${1:element}.innerHTML = `${2:<p>content</p>}`;', 'innerHTML', 'Set element inner HTML'),
    snip(monaco, 'textContent', '${1:element}.textContent = \'${2:text}\';', 'textContent', 'Set element text content'),
    snip(monaco, 'setAttribute', '${1:element}.setAttribute(\'${2:data-id}\', \'${3:value}\');', 'setAttribute', 'Set element attribute'),
    snip(monaco, 'getAttribute', 'const ${1:val} = ${2:element}.getAttribute(\'${3:data-id}\');', 'getAttribute', 'Get element attribute'),
    snip(monaco, 'removeAttribute', '${1:element}.removeAttribute(\'${2:disabled}\');', 'removeAttribute', 'Remove element attribute'),
    snip(monaco, 'classList-add', '${1:element}.classList.add(\'${2:active}\');', 'classList.add', 'Add CSS class to element'),
    snip(monaco, 'classList-remove', '${1:element}.classList.remove(\'${2:active}\');', 'classList.remove', 'Remove CSS class from element'),
    snip(monaco, 'classList-toggle', '${1:element}.classList.toggle(\'${2:active}\');', 'classList.toggle', 'Toggle CSS class on element'),
    snip(monaco, 'classList-contains', 'if (${1:element}.classList.contains(\'${2:active}\')) {\n\t$0\n}', 'classList.contains', 'Check if element has class'),
    snip(monaco, 'style-set', '${1:element}.style.${2:display} = \'${3:none}\';', 'element.style', 'Set inline style'),
    snip(monaco, 'dataset', 'const ${1:val} = ${2:element}.dataset.${3:id};', 'dataset', 'Access data attribute via dataset'),
    snip(monaco, 'dataset-set', '${1:element}.dataset.${2:id} = \'${3:value}\';', 'dataset set', 'Set data attribute via dataset'),
    snip(monaco, 'appendChild', '${1:parent}.appendChild(${2:child});', 'appendChild', 'Append child element'),
    snip(monaco, 'removeChild', '${1:parent}.removeChild(${2:child});', 'removeChild', 'Remove child element'),
    snip(monaco, 'remove', '${1:element}.remove();', 'element.remove()', 'Remove element from DOM'),
    snip(monaco, 'insertBefore', '${1:parent}.insertBefore(${2:newEl}, ${3:refEl});', 'insertBefore', 'Insert element before reference'),
    snip(monaco, 'insertAdjacentHTML',
      '${1:element}.insertAdjacentHTML(\'${2:beforeend}\', `${3:<p>content</p>}`);',
      'insertAdjacentHTML', 'Insert HTML adjacent to element (beforebegin/afterbegin/beforeend/afterend)'),
    snip(monaco, 'cloneNode', 'const ${1:clone} = ${2:element}.cloneNode(${3:true});', 'cloneNode', 'Clone DOM element (true = deep clone)'),
    snip(monaco, 'closest', 'const ${1:parent} = ${2:element}.closest(\'${3:.container}\');', 'closest', 'Find closest ancestor matching selector'),
    snip(monaco, 'matches', 'if (${1:element}.matches(\'${2:.active}\')) {\n\t$0\n}', 'matches', 'Check if element matches selector'),
    snip(monaco, 'getBoundingClientRect', 'const ${1:rect} = ${2:element}.getBoundingClientRect();\nconst { top, left, width, height } = ${1:rect};', 'getBoundingClientRect', 'Get element position and size'),
    snip(monaco, 'scrollIntoView', '${1:element}.scrollIntoView({ behavior: \'smooth\', block: \'${2:start}\' });', 'scrollIntoView', 'Scroll element into viewport'),
    snip(monaco, 'focus-el', '${1:element}.focus();', 'element.focus()', 'Focus an element'),
    snip(monaco, 'querySelectorAll-forEach',
      'document.querySelectorAll(\'${1:.item}\').forEach(el => {\n\t$0\n});',
      'querySelectorAll + forEach', 'Select all elements and iterate'),
    snip(monaco, 'dom-ready',
      'document.addEventListener(\'DOMContentLoaded\', () => {\n\t$0\n});',
      'DOMContentLoaded', 'Run code when DOM is ready'),
    snip(monaco, 'window-load',
      'window.addEventListener(\'load\', () => {\n\t$0\n});',
      'window.load', 'Run code when all resources are loaded'),
  ];
}

// ─── JS Event Snippets ──────────────────────────────────────────────────────

function getJsEventSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    snip(monaco, 'addEventListener',
      '${1:element}.addEventListener(\'${2:click}\', function(event) {\n\t$0\n});',
      'addEventListener', 'Add event listener to element'),
    snip(monaco, 'addEventListener-arrow',
      '${1:element}.addEventListener(\'${2:click}\', (event) => {\n\t$0\n});',
      'addEventListener (arrow)', 'Add event listener with arrow function'),
    snip(monaco, 'removeEventListener',
      '${1:element}.removeEventListener(\'${2:click}\', ${3:handlerFunction});',
      'removeEventListener', 'Remove event listener'),
    snip(monaco, 'event-delegation',
      'document.getElementById(\'${1:container}\').addEventListener(\'${2:click}\', (event) => {\n\tif (event.target.matches(\'${3:.item}\')) {\n\t\t$0\n\t}\n});',
      'Event delegation', 'Event delegation pattern'),
    snip(monaco, 'preventDefault',
      '${1:element}.addEventListener(\'${2:submit}\', (event) => {\n\tevent.preventDefault();\n\t$0\n});',
      'preventDefault', 'Prevent default event behavior'),
    snip(monaco, 'stopPropagation',
      'event.stopPropagation();',
      'stopPropagation', 'Stop event from bubbling up'),
    snip(monaco, 'event-target',
      'const target = event.target;\nconst value = event.target.value;\nconst id = event.target.id;',
      'event.target', 'Access event target and properties'),
    snip(monaco, 'input-change',
      'document.getElementById(\'${1:input}\').addEventListener(\'input\', (e) => {\n\tconst value = e.target.value;\n\t$0\n});',
      'Input change', 'Listen for input value changes'),
    snip(monaco, 'form-submit',
      'document.getElementById(\'${1:myForm}\').addEventListener(\'submit\', (e) => {\n\te.preventDefault();\n\tconst data = new FormData(e.target);\n\t$0\n});',
      'Form submit', 'Handle form submission'),
    snip(monaco, 'keyboard-event',
      'document.addEventListener(\'keydown\', (e) => {\n\tif (e.key === \'${1:Enter}\') {\n\t\t$0\n\t}\n});',
      'Keyboard event', 'Listen for keydown event'),
    snip(monaco, 'mouse-event',
      '${1:element}.addEventListener(\'${2:click}\', (e) => {\n\tconst { clientX, clientY } = e;\n\t$0\n});',
      'Mouse event', 'Listen for mouse event with coordinates'),
    snip(monaco, 'scroll-event',
      'window.addEventListener(\'scroll\', () => {\n\tconst scrollY = window.scrollY;\n\t$0\n});',
      'Scroll event', 'Listen for scroll event'),
    snip(monaco, 'resize-event',
      'window.addEventListener(\'resize\', () => {\n\tconst { innerWidth, innerHeight } = window;\n\t$0\n});',
      'Resize event', 'Listen for window resize'),
    snip(monaco, 'custom-event',
      'const ${1:myEvent} = new CustomEvent(\'${2:my-event}\', {\n\tdetail: { ${3:data: \'value\'} },\n\tbubbles: true,\n\tcancelable: true,\n});\n${4:element}.dispatchEvent(${1:myEvent});',
      'Custom event', 'Create and dispatch custom event'),
    snip(monaco, 'once-event',
      '${1:element}.addEventListener(\'${2:click}\', (e) => {\n\t$0\n}, { once: true });',
      'Once event', 'Event listener that fires only once'),
    snip(monaco, 'passive-event',
      '${1:element}.addEventListener(\'${2:scroll}\', (e) => {\n\t$0\n}, { passive: true });',
      'Passive event', 'Passive event listener (better scroll performance)'),
  ];
}

// ─── JS Fetch Snippets ──────────────────────────────────────────────────────

function getJsFetchSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    snip(monaco, 'fetch-get',
      'fetch(\'${1:https://api.example.com/data}\')\n\t.then(res => {\n\t\tif (!res.ok) throw new Error(`HTTP error! status: ${2:\\${res.status}}`);\n\t\treturn res.json();\n\t})\n\t.then(data => {\n\t\tconsole.log(data);\n\t\t$0\n\t})\n\t.catch(err => console.error(\'Fetch error:\', err));',
      'fetch GET', 'GET request with .then() chain'),
    snip(monaco, 'fetch-async',
      'async function ${1:fetchData}() {\n\ttry {\n\t\tconst res = await fetch(\'${2:https://api.example.com/data}\');\n\t\tif (!res.ok) throw new Error(`HTTP error! status: ${3:\\${res.status}}`);\n\t\tconst data = await res.json();\n\t\t$0\n\t\treturn data;\n\t} catch (err) {\n\t\tconsole.error(\'Fetch error:\', err);\n\t}\n}',
      'fetch async/await GET', 'Async/await GET request'),
    snip(monaco, 'fetch-post',
      'fetch(\'${1:https://api.example.com/data}\', {\n\tmethod: \'POST\',\n\theaders: { \'Content-Type\': \'application/json\' },\n\tbody: JSON.stringify(${2:{ key: \'value\' }}),\n})\n\t.then(res => res.json())\n\t.then(data => {\n\t\tconsole.log(data);\n\t\t$0\n\t})\n\t.catch(err => console.error(err));',
      'fetch POST', 'POST request with JSON body'),
    snip(monaco, 'fetch-post-async',
      'async function ${1:postData}(${2:url}, ${3:body}) {\n\ttry {\n\t\tconst res = await fetch(${2:url}, {\n\t\t\tmethod: \'POST\',\n\t\t\theaders: { \'Content-Type\': \'application/json\' },\n\t\t\tbody: JSON.stringify(${3:body}),\n\t\t});\n\t\tif (!res.ok) throw new Error(`HTTP ${4:\\${res.status}}`);\n\t\treturn await res.json();\n\t} catch (err) {\n\t\tconsole.error(err);\n\t\tthrow err;\n\t}\n}',
      'fetch POST async', 'Async POST request function'),
    snip(monaco, 'fetch-put',
      'fetch(\'${1:https://api.example.com/data/${2:id}}\', {\n\tmethod: \'PUT\',\n\theaders: { \'Content-Type\': \'application/json\' },\n\tbody: JSON.stringify(${3:{ key: \'value\' }}),\n})\n\t.then(res => res.json())\n\t.then(data => console.log(data))\n\t.catch(err => console.error(err));',
      'fetch PUT', 'PUT request to update resource'),
    snip(monaco, 'fetch-delete',
      'fetch(\'${1:https://api.example.com/data/${2:id}}\', {\n\tmethod: \'DELETE\',\n})\n\t.then(res => {\n\t\tif (res.ok) console.log(\'Deleted\');\n\t})\n\t.catch(err => console.error(err));',
      'fetch DELETE', 'DELETE request'),
    snip(monaco, 'fetch-headers',
      'const headers = new Headers({\n\t\'Content-Type\': \'application/json\',\n\t\'Authorization\': `Bearer ${1:\\${token}}`,\n\t\'Accept\': \'application/json\',\n});\n\nfetch(\'${2:url}\', { headers })\n\t.then(res => res.json())\n\t.then(data => console.log(data));',
      'fetch with headers', 'Fetch with Authorization headers'),
    snip(monaco, 'fetch-abort',
      'const controller = new AbortController();\nconst signal = controller.signal;\n\nfetch(\'${1:url}\', { signal })\n\t.then(res => res.json())\n\t.then(data => console.log(data))\n\t.catch(err => {\n\t\tif (err.name === \'AbortError\') console.log(\'Fetch aborted\');\n\t});\n\n// Abort after timeout\nsetTimeout(() => controller.abort(), ${2:5000});',
      'fetch + AbortController', 'Fetch with timeout/abort'),
  ];
}

// ─── JS Storage Snippets ────────────────────────────────────────────────────

function getJsStorageSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    snip(monaco, 'ls-set', 'localStorage.setItem(\'${1:key}\', ${2:value});', 'localStorage.setItem', 'Set localStorage item'),
    snip(monaco, 'ls-get', 'const ${1:value} = localStorage.getItem(\'${2:key}\');', 'localStorage.getItem', 'Get localStorage item'),
    snip(monaco, 'ls-remove', 'localStorage.removeItem(\'${1:key}\');', 'localStorage.removeItem', 'Remove localStorage item'),
    snip(monaco, 'ls-clear', 'localStorage.clear();', 'localStorage.clear', 'Clear all localStorage'),
    snip(monaco, 'ls-json-set', 'localStorage.setItem(\'${1:key}\', JSON.stringify(${2:data}));', 'localStorage JSON set', 'Store object/array in localStorage'),
    snip(monaco, 'ls-json-get', 'const ${1:data} = JSON.parse(localStorage.getItem(\'${2:key}\') || \'${3:null}\');', 'localStorage JSON get', 'Retrieve and parse JSON from localStorage'),
    snip(monaco, 'ss-set', 'sessionStorage.setItem(\'${1:key}\', ${2:value});', 'sessionStorage.setItem', 'Set sessionStorage item'),
    snip(monaco, 'ss-get', 'const ${1:value} = sessionStorage.getItem(\'${2:key}\');', 'sessionStorage.getItem', 'Get sessionStorage item'),
    snip(monaco, 'ss-remove', 'sessionStorage.removeItem(\'${1:key}\');', 'sessionStorage.removeItem', 'Remove sessionStorage item'),
    snip(monaco, 'cookie-set', 'document.cookie = `${1:name}=${2:value}; expires=${3:\\${new Date(Date.now() + 86400 * 1000).toUTCString()}}; path=/`;', 'Cookie set', 'Set a browser cookie'),
    snip(monaco, 'cookie-get',
      'function getCookie(name) {\n\tconst value = `; ${2:\\${document.cookie}}`;\n\tconst parts = value.split(`; ${3:\\${name}}=`);\n\tif (parts.length === 2) return parts.pop().split(\';\').shift();\n}',
      'Cookie get', 'Get cookie by name function'),
  ];
}

// ─── JS Pattern Snippets ────────────────────────────────────────────────────

function getJsPatternSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    // Timing
    snip(monaco, 'setTimeout',
      'setTimeout(() => {\n\t$0\n}, ${1:1000});',
      'setTimeout', 'Delayed one-time execution'),
    snip(monaco, 'setInterval',
      'const ${1:intervalId} = setInterval(() => {\n\t$0\n}, ${2:1000});',
      'setInterval', 'Repeated execution at interval'),
    snip(monaco, 'clearTimeout', 'clearTimeout(${1:timeoutId});', 'clearTimeout', 'Cancel setTimeout'),
    snip(monaco, 'clearInterval', 'clearInterval(${1:intervalId});', 'clearInterval', 'Cancel setInterval'),
    snip(monaco, 'requestAnimationFrame',
      'function ${1:animate}() {\n\t$0\n\trequestAnimationFrame(${1:animate});\n}\nrequestAnimationFrame(${1:animate});',
      'requestAnimationFrame', 'Animation loop with rAF'),
    // Promise
    snip(monaco, 'Promise-new',
      'const ${1:promise} = new Promise((resolve, reject) => {\n\t${2:// async operation}\n\tif (${3:success}) {\n\t\tresolve(${4:result});\n\t} else {\n\t\treject(new Error(\'${5:Error message}\'));\n\t}\n});',
      'new Promise', 'Create a new Promise'),
    snip(monaco, 'Promise-all',
      'const [${1:res1}, ${2:res2}] = await Promise.all([\n\t${3:fetch(url1).then(r => r.json())},\n\t${4:fetch(url2).then(r => r.json())},\n]);',
      'Promise.all', 'Run multiple promises in parallel'),
    snip(monaco, 'Promise-allSettled',
      'const results = await Promise.allSettled([\n\t${1:promise1},\n\t${2:promise2},\n]);\nresults.forEach(result => {\n\tif (result.status === \'fulfilled\') console.log(result.value);\n\telse console.error(result.reason);\n});',
      'Promise.allSettled', 'Run promises, handle all results'),
    snip(monaco, 'async-function',
      'async function ${1:myFunction}(${2:params}) {\n\ttry {\n\t\t$0\n\t} catch (error) {\n\t\tconsole.error(error);\n\t}\n}',
      'async function', 'Async function with try/catch'),
    snip(monaco, 'try-catch',
      'try {\n\t$0\n} catch (error) {\n\tconsole.error(error);\n} finally {\n\t${1:// cleanup}\n}',
      'try/catch/finally', 'Try-catch-finally block'),
    // Class
    snip(monaco, 'class',
      'class ${1:MyClass} ${2:extends ${3:ParentClass} }{\n\tconstructor(${4:params}) {\n\t\t${5:super(${4:params});}\n\t\tthis.${6:property} = ${7:value};\n\t}\n\n\t${8:myMethod}() {\n\t\t$0\n\t}\n}',
      'class', 'ES6 class definition'),
    snip(monaco, 'class-get-set',
      'get ${1:name}() {\n\treturn this._${1:name};\n}\n\nset ${1:name}(value) {\n\tthis._${1:name} = value;\n}',
      'Getter/Setter', 'Class getter and setter'),
    // Modules
    snip(monaco, 'export-default', 'export default ${1:MyClass};', 'export default', 'Default export'),
    snip(monaco, 'export-named', 'export { ${1:function1}, ${2:function2} };', 'Named export', 'Named exports'),
    snip(monaco, 'export-function', 'export function ${1:myFunction}(${2:params}) {\n\t$0\n}', 'export function', 'Exported function'),
    snip(monaco, 'export-const', 'export const ${1:myConst} = ${2:value};', 'export const', 'Exported constant'),
    snip(monaco, 'import', 'import ${1:{ something }} from \'${2:./module}\';', 'import', 'ES6 import statement'),
    snip(monaco, 'import-default', 'import ${1:MyClass} from \'${2:./module}\';', 'import default', 'Default import'),
    snip(monaco, 'import-all', 'import * as ${1:alias} from \'${2:./module}\';', 'import *', 'Import all as namespace'),
    snip(monaco, 'import-dynamic', 'const ${1:module} = await import(\'${2:./module.js}\');', 'Dynamic import', 'Dynamic ES module import'),
    // Destructuring
    snip(monaco, 'destructure-obj', 'const { ${1:property1}, ${2:property2} } = ${3:object};', 'Object destructuring', 'Object destructuring'),
    snip(monaco, 'destructure-arr', 'const [${1:first}, ${2:second}, ...${3:rest}] = ${4:array};', 'Array destructuring', 'Array destructuring with rest'),
    snip(monaco, 'destructure-rename', 'const { ${1:name}: ${2:newName}, ${3:age} = ${4:0} } = ${5:object};', 'Destructure + rename', 'Destructuring with rename and default'),
    // Spread / Rest
    snip(monaco, 'spread-obj', 'const ${1:merged} = { ...${2:obj1}, ...${3:obj2} };', 'Spread objects', 'Merge/clone objects with spread'),
    snip(monaco, 'spread-arr', 'const ${1:combined} = [...${2:arr1}, ...${3:arr2}];', 'Spread arrays', 'Merge/clone arrays with spread'),
    // For loops
    snip(monaco, 'for-of',
      'for (const ${1:item} of ${2:items}) {\n\t$0\n}',
      'for...of', 'Iterate over iterable values'),
    snip(monaco, 'for-in',
      'for (const ${1:key} in ${2:object}) {\n\tif (Object.hasOwn(${2:object}, ${1:key})) {\n\t\t$0\n\t}\n}',
      'for...in', 'Iterate over object keys'),
    snip(monaco, 'for-entries',
      'Object.entries(${1:obj}).forEach(([${2:key}, ${3:value}]) => {\n\t$0\n});',
      'Object.entries forEach', 'Iterate over object entries'),
    // Conditional
    snip(monaco, 'ternary', 'const ${1:result} = ${2:condition} ? ${3:valueIfTrue} : ${4:valueIfFalse};', 'Ternary', 'Ternary operator'),
    snip(monaco, 'nullish', 'const ${1:value} = ${2:data} ?? ${3:defaultValue};', 'Nullish coalescing ??', 'Nullish coalescing operator'),
    snip(monaco, 'optional-chain', 'const ${1:value} = ${2:obj}?.${3:prop}?.${4:nestedProp};', 'Optional chaining ?.', 'Optional chaining'),
    // String
    snip(monaco, 'template-literal', '`${1:Hello}, ${2:\\${name}}!`', 'Template literal', 'Template string with interpolation'),
    snip(monaco, 'tagged-template', 'const ${1:result} = ${2:html}`<div>${3:\\${data}}</div>`;', 'Tagged template', 'Tagged template literal'),
    // Console
    snip(monaco, 'cl', 'console.log(${1:value});', 'console.log', 'Log to console'),
    snip(monaco, 'ce', 'console.error(${1:error});', 'console.error', 'Log error to console'),
    snip(monaco, 'ct', 'console.table(${1:data});', 'console.table', 'Display data as table'),
    snip(monaco, 'cw', 'console.warn(${1:message});', 'console.warn', 'Console warning'),
    snip(monaco, 'cg', 'console.group(\'${1:Group}\');\n$0\nconsole.groupEnd();', 'console.group', 'Console group'),
    snip(monaco, 'ctime', 'console.time(\'${1:label}\');\n$0\nconsole.timeEnd(\'${1:label}\');', 'console.time', 'Time measurement'),
    // Array
    snip(monaco, 'Array-from', 'const ${1:arr} = Array.from(${2:nodeList});', 'Array.from', 'Convert iterable to array'),
    snip(monaco, 'Array-map', 'const ${1:result} = ${2:array}.map(${3:item} => ${4:item});', 'Array.map', 'Map array to new array'),
    snip(monaco, 'Array-filter', 'const ${1:result} = ${2:array}.filter(${3:item} => ${4:item.active});', 'Array.filter', 'Filter array items'),
    snip(monaco, 'Array-reduce', 'const ${1:total} = ${2:array}.reduce((acc, ${3:item}) => acc + ${3:item}, ${4:0});', 'Array.reduce', 'Reduce array to single value'),
    snip(monaco, 'Array-find', 'const ${1:found} = ${2:array}.find(${3:item} => ${3:item}.id === ${4:id});', 'Array.find', 'Find first matching item'),
    snip(monaco, 'Array-findIndex', 'const ${1:idx} = ${2:array}.findIndex(${3:item} => ${3:item}.id === ${4:id});', 'Array.findIndex', 'Find index of first match'),
    snip(monaco, 'Array-includes', 'const ${1:has} = ${2:array}.includes(${3:value});', 'Array.includes', 'Check if array includes value'),
    snip(monaco, 'Array-flat', 'const ${1:flat} = ${2:array}.flat(${3:Infinity});', 'Array.flat', 'Flatten nested arrays'),
    snip(monaco, 'Array-flatMap', 'const ${1:result} = ${2:array}.flatMap(${3:item} => [${3:item}, ${3:item} * 2]);', 'Array.flatMap', 'Map then flatten'),
    snip(monaco, 'Array-sort-num', '${1:array}.sort((a, b) => a - b); // ascending', 'Array sort numeric', 'Sort array numerically'),
    snip(monaco, 'Array-sort-str', '${1:array}.sort((a, b) => a.localeCompare(b)); // alphabetical', 'Array sort string', 'Sort array alphabetically'),
    // String
    snip(monaco, 'str-split-join', 'const ${1:result} = ${2:str}.split(\'${3:,}\').join(\'${4: }\');', 'split + join', 'Split and rejoin string'),
    snip(monaco, 'str-trim', 'const ${1:trimmed} = ${2:str}.trim();', 'String trim', 'Trim whitespace from string'),
    snip(monaco, 'str-replace', 'const ${1:result} = ${2:str}.replace(/\${3:pattern}/g, \'${4:replacement}\');', 'String replace', 'Replace with regex'),
    snip(monaco, 'regex-match', 'const ${1:matches} = \'${2:string}\'.match(/${3:pattern}/g);', 'String match regex', 'Match pattern in string'),
    // Object
    snip(monaco, 'Object-keys', 'const ${1:keys} = Object.keys(${2:obj});', 'Object.keys', 'Get object keys'),
    snip(monaco, 'Object-values', 'const ${1:values} = Object.values(${2:obj});', 'Object.values', 'Get object values'),
    snip(monaco, 'Object-entries', 'const ${1:entries} = Object.entries(${2:obj});', 'Object.entries', 'Get [key, value] pairs'),
    snip(monaco, 'Object-assign', 'const ${1:merged} = Object.assign({}, ${2:target}, ${3:source});', 'Object.assign', 'Merge objects'),
    snip(monaco, 'Object-freeze', 'const ${1:frozen} = Object.freeze({ ${2:key}: \'${3:value}\' });', 'Object.freeze', 'Create immutable object'),
    snip(monaco, 'structuredClone', 'const ${1:clone} = structuredClone(${2:original});', 'structuredClone', 'Deep clone object'),
    // JSON
    snip(monaco, 'JSON-stringify', 'const ${1:str} = JSON.stringify(${2:data}, null, 2);', 'JSON.stringify', 'Convert to JSON string'),
    snip(monaco, 'JSON-parse', 'const ${1:data} = JSON.parse(${2:jsonString});', 'JSON.parse', 'Parse JSON string'),
    snip(monaco, 'JSON-parse-safe',
      'let ${1:data};\ntry {\n\t${1:data} = JSON.parse(${2:str});\n} catch (e) {\n\t${1:data} = ${3:null};\n}',
      'JSON.parse safe', 'Safe JSON.parse with try/catch'),
    // Math
    snip(monaco, 'Math-random', 'const ${1:n} = Math.floor(Math.random() * ${2:100});', 'Random integer', 'Random integer 0 to N-1'),
    snip(monaco, 'Math-range', 'const ${1:n} = Math.floor(Math.random() * (${2:max} - ${3:min} + 1)) + ${3:min};', 'Random in range', 'Random integer in [min, max]'),
    // URL / History
    snip(monaco, 'URL-params', 'const params = new URLSearchParams(window.location.search);\nconst ${1:id} = params.get(\'${1:id}\');', 'URL params', 'Get URL search params'),
    snip(monaco, 'history-push', 'history.pushState({ ${1:data} }, \'${2:title}\', \'${3:/path}\');', 'history.pushState', 'Push new URL to history'),
    snip(monaco, 'location-redirect', 'window.location.href = \'${1:https://example.com}\';', 'location.href', 'Redirect to URL'),
    snip(monaco, 'location-reload', 'window.location.reload();', 'location.reload', 'Reload current page'),
  ];
}

// ─── Public Export ─────────────────────────────────────────────────────────

export function getJsCompletions(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    ...getJsDomSnippets(monaco),
    ...getJsEventSnippets(monaco),
    ...getJsFetchSnippets(monaco),
    ...getJsStorageSnippets(monaco),
    ...getJsPatternSnippets(monaco),
  ];
}
