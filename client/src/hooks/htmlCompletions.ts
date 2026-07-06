import type * as Monaco from 'monaco-editor';

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function bsCls(
  monaco: typeof Monaco,
  label: string,
  documentation: string
): Monaco.languages.CompletionItem {
  return {
    label,
    kind: monaco.languages.CompletionItemKind.Value,
    detail: 'Bootstrap 5',
    documentation: { value: `**Bootstrap 5 class** — ${documentation}`, isTrusted: true },
    insertText: label,
    range: undefined as unknown as Monaco.IRange,
  };
}

// ─── HTML5 Structural Snippets ─────────────────────────────────────────────

function getHtml5Snippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    snip(monaco, 'html5', '<!DOCTYPE html>\n<html lang="vi">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>${1:Document}</title>\n</head>\n<body>\n\t$0\n</body>\n</html>', 'HTML5 Boilerplate', 'Full HTML5 document structure'),
    snip(monaco, 'html5-bootstrap', '<!DOCTYPE html>\n<html lang="vi">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>${1:Document}</title>\n\t<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">\n</head>\n<body>\n\t$0\n\t<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"><\\/script>\n</body>\n</html>', 'HTML5 + Bootstrap 5', 'Full HTML5 document with Bootstrap 5 CDN'),
    snip(monaco, 'meta:viewport', '<meta name="viewport" content="width=device-width, initial-scale=1.0">', 'Viewport meta', 'Responsive viewport meta tag'),
    snip(monaco, 'meta:charset', '<meta charset="${1:UTF-8}">', 'Charset meta', 'Character encoding meta tag'),
    snip(monaco, 'meta:og', '<meta property="og:title" content="${1:Title}">\n<meta property="og:description" content="${2:Desc}">\n<meta property="og:image" content="${3:img.jpg}">', 'Open Graph', 'OG social media meta tags'),
    snip(monaco, 'link:css', '<link rel="stylesheet" href="${1:styles.css}">', 'Link CSS', 'External stylesheet link'),
    snip(monaco, 'link:favicon', '<link rel="icon" type="image/x-icon" href="${1:favicon.ico}">', 'Favicon', 'Favicon link'),
    snip(monaco, 'script:src', '<script src="${1:script.js}"><\\/script>', 'Script', 'External JS link'),
    snip(monaco, 'script:defer', '<script defer src="${1:script.js}"><\\/script>', 'Script defer', 'Deferred JS'),
    snip(monaco, 'script:module', '<script type="module" src="${1:main.js}"><\\/script>', 'Script module', 'ES module script'),
    snip(monaco, 'header', '<header>\n\t$0\n</header>', 'HTML header', 'Semantic <header> element'),
    snip(monaco, 'nav', '<nav>\n\t$0\n</nav>', 'HTML nav', 'Semantic <nav> element'),
    snip(monaco, 'main', '<main>\n\t$0\n</main>', 'HTML main', 'Semantic <main> element'),
    snip(monaco, 'footer', '<footer>\n\t$0\n</footer>', 'HTML footer', 'Semantic <footer> element'),
    snip(monaco, 'section', '<section>\n\t<h${1:2}>${2:Section Title}</h${1:2}>\n\t$0\n</section>', 'HTML section', 'Semantic <section> element'),
    snip(monaco, 'article', '<article>\n\t<h${1:2}>${2:Article Title}</h${1:2}>\n\t$0\n</article>', 'HTML article', 'Semantic <article> element'),
    snip(monaco, 'aside', '<aside>\n\t$0\n</aside>', 'HTML aside', 'Semantic <aside> element'),
    snip(monaco, 'figure', '<figure>\n\t<img src="${1:image.jpg}" alt="${2:Description}">\n\t<figcaption>${3:Caption}</figcaption>\n</figure>', 'HTML figure', '<figure> with image and caption'),
    snip(monaco, 'details', '<details>\n\t<summary>${1:Click to expand}</summary>\n\t$0\n</details>', 'HTML details', 'Collapsible <details>'),
    snip(monaco, 'dialog', '<dialog id="${1:myDialog}">\n\t<h2>${2:Title}</h2>\n\t<p>$3</p>\n\t<button onclick="document.getElementById(\'${1:myDialog}\').close()">Close</button>\n</dialog>', 'HTML dialog', 'Native HTML dialog element'),
    snip(monaco, 'div', '<div class="${1:container}">\n\t$0\n</div>', 'HTML div', 'div with class'),
    snip(monaco, 'span', '<span class="${1:}">${2:text}</span>', 'HTML span', 'Inline span'),
    snip(monaco, 'a', '<a href="${1:#}" ${2:target="_blank"}>${3:Link text}</a>', 'Anchor', '<a> hyperlink'),
    snip(monaco, 'a:blank', '<a href="${1:https://example.com}" target="_blank" rel="noopener noreferrer">${2:Link text}</a>', 'External link', 'External link with security attrs'),
    snip(monaco, 'h1', '<h1>${1:Heading 1}</h1>', 'h1', '<h1> heading'),
    snip(monaco, 'h2', '<h2>${1:Heading 2}</h2>', 'h2', '<h2> heading'),
    snip(monaco, 'h3', '<h3>${1:Heading 3}</h3>', 'h3', '<h3> heading'),
    snip(monaco, 'p', '<p>${1:Paragraph.}</p>', 'paragraph', '<p> element'),
  ];
}

// ─── HTML Form Snippets ────────────────────────────────────────────────────

function getHtmlFormSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    snip(monaco, 'form', '<form action="${1:#}" method="${2:post}" id="${3:myForm}">\n\t$0\n\t<button type="submit">Submit</button>\n</form>', 'HTML form', 'Form element'),
    snip(monaco, 'input:text', '<input type="text" id="${1:name}" name="${1:name}" placeholder="${2:Enter text}" ${3:required}>', 'Input text', 'Text input'),
    snip(monaco, 'input:email', '<input type="email" id="${1:email}" name="${1:email}" placeholder="${2:Email}" ${3:required}>', 'Input email', 'Email input'),
    snip(monaco, 'input:password', '<input type="password" id="${1:pwd}" name="${1:pwd}" placeholder="${2:Password}" ${3:required}>', 'Input password', 'Password input'),
    snip(monaco, 'input:number', '<input type="number" id="${1:qty}" name="${1:qty}" min="${2:0}" max="${3:100}" value="${4:1}">', 'Input number', 'Number input'),
    snip(monaco, 'input:date', '<input type="date" id="${1:date}" name="${1:date}">', 'Input date', 'Date picker'),
    snip(monaco, 'input:file', '<input type="file" id="${1:file}" name="${1:file}" accept="${2:.jpg,.png}">', 'Input file', 'File upload'),
    snip(monaco, 'input:checkbox', '<input type="checkbox" id="${1:check}" name="${1:check}" value="${2:1}">', 'Checkbox', 'Checkbox input'),
    snip(monaco, 'input:radio', '<input type="radio" id="${1:opt1}" name="${2:grp}" value="${3:v1}">\n<label for="${1:opt1}">${4:Option 1}</label>', 'Radio', 'Radio button'),
    snip(monaco, 'input:hidden', '<input type="hidden" name="${1:token}" value="${2:}">', 'Hidden', 'Hidden form field'),
    snip(monaco, 'input:search', '<input type="search" id="${1:q}" name="${1:q}" placeholder="${2:Search...}">', 'Search', 'Search input'),
    snip(monaco, 'input:range', '<input type="range" id="${1:vol}" name="${1:vol}" min="${2:0}" max="${3:100}" value="${4:50}">', 'Range', 'Slider input'),
    snip(monaco, 'input:color', '<input type="color" id="${1:color}" name="${1:color}" value="${2:#000000}">', 'Color', 'Color picker'),
    snip(monaco, 'label', '<label for="${1:id}">${2:Label text}</label>', 'Label', 'Form label'),
    snip(monaco, 'textarea', '<textarea id="${1:msg}" name="${1:msg}" rows="${2:5}" placeholder="${3:Enter message}">${4:}</textarea>', 'Textarea', 'Multi-line input'),
    snip(monaco, 'select', '<select id="${1:sel}" name="${1:sel}">\n\t<option value="">-- Select --</option>\n\t<option value="${2:v1}">${3:Option 1}</option>\n\t<option value="${4:v2}">${5:Option 2}</option>\n</select>', 'Select', 'Dropdown select'),
    snip(monaco, 'datalist', '<input list="${1:opts}" id="${2:inp}" name="${2:inp}">\n<datalist id="${1:opts}">\n\t<option value="${3:Option 1}">\n\t<option value="${4:Option 2}">\n</datalist>', 'Datalist', 'Autocomplete datalist'),
    snip(monaco, 'fieldset', '<fieldset>\n\t<legend>${1:Group}</legend>\n\t$0\n</fieldset>', 'Fieldset', 'Fieldset with legend'),
    snip(monaco, 'button', '<button type="${1:button}" id="${2:btn}">${3:Click Me}</button>', 'Button', 'Button element'),
    snip(monaco, 'button:submit', '<button type="submit">${1:Submit}</button>', 'Submit button', 'Form submit button'),
  ];
}

// ─── HTML Table & List Snippets ────────────────────────────────────────────

function getHtmlTableSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    snip(monaco, 'table', '<table>\n\t<thead>\n\t\t<tr><th>${1:Col 1}</th><th>${2:Col 2}</th></tr>\n\t</thead>\n\t<tbody>\n\t\t<tr><td>${3:Data 1}</td><td>${4:Data 2}</td></tr>\n\t</tbody>\n</table>', 'HTML table', 'Table with thead/tbody'),
    snip(monaco, 'table:full', '<table>\n\t<caption>${1:Caption}</caption>\n\t<thead><tr><th>${2:Col 1}</th><th>${3:Col 2}</th></tr></thead>\n\t<tbody><tr><td>$4</td><td>$5</td></tr></tbody>\n\t<tfoot><tr><td colspan="2">${6:Footer}</td></tr></tfoot>\n</table>', 'Full table', 'caption+thead+tbody+tfoot'),
    snip(monaco, 'tr', '<tr>\n\t<td>${1}</td>\n\t<td>${2}</td>\n</tr>', 'Table row', 'tr + td'),
    snip(monaco, 'ul', '<ul>\n\t<li>${1:Item 1}</li>\n\t<li>${2:Item 2}</li>\n\t<li>${3:Item 3}</li>\n</ul>', 'Unordered list', 'ul + li'),
    snip(monaco, 'ol', '<ol>\n\t<li>${1:Item 1}</li>\n\t<li>${2:Item 2}</li>\n\t<li>${3:Item 3}</li>\n</ol>', 'Ordered list', 'ol + li'),
    snip(monaco, 'li', '<li>${1:Item}</li>', 'List item', '<li>'),
    snip(monaco, 'dl', '<dl>\n\t<dt>${1:Term}</dt>\n\t<dd>${2:Definition}</dd>\n</dl>', 'Description list', 'dl/dt/dd'),
  ];
}

// ─── HTML Media & Embed Snippets ───────────────────────────────────────────

function getHtmlMediaSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    snip(monaco, 'img', '<img src="${1:image.jpg}" alt="${2:Description}" width="${3:}" height="${4:}">', 'Image', '<img> element'),
    snip(monaco, 'img:responsive', '<img src="${1:image.jpg}" alt="${2:Description}" class="img-fluid">', 'Responsive img', 'Bootstrap img-fluid'),
    snip(monaco, 'picture', '<picture>\n\t<source media="(min-width: 768px)" srcset="${1:large.jpg}">\n\t<img src="${2:small.jpg}" alt="${3:Description}">\n</picture>', 'Picture', 'Responsive picture'),
    snip(monaco, 'video', '<video width="${1:640}" height="${2:360}" controls>\n\t<source src="${3:video.mp4}" type="video/mp4">\n\tBrowser does not support video.\n</video>', 'Video', 'HTML5 video'),
    snip(monaco, 'audio', '<audio controls>\n\t<source src="${1:audio.mp3}" type="audio/mp3">\n\tBrowser does not support audio.\n</audio>', 'Audio', 'HTML5 audio'),
    snip(monaco, 'iframe', '<iframe src="${1:https://example.com}" width="${2:600}" height="${3:400}" frameborder="0" allowfullscreen title="${4:Embedded}"></iframe>', 'iFrame', 'Embedded iframe'),
    snip(monaco, 'iframe:youtube', '<iframe width="${1:560}" height="${2:315}" src="https://www.youtube.com/embed/${3:VIDEO_ID}" title="YouTube" frameborder="0" allowfullscreen></iframe>', 'YouTube iframe', 'YouTube embed'),
    snip(monaco, 'canvas', '<canvas id="${1:myCanvas}" width="${2:800}" height="${3:600}">\n\tBrowser does not support canvas.\n</canvas>', 'Canvas', 'HTML5 canvas'),
    snip(monaco, 'svg', '<svg xmlns="http://www.w3.org/2000/svg" width="${1:100}" height="${2:100}" viewBox="0 0 ${1:100} ${2:100}">\n\t$0\n</svg>', 'SVG', 'Inline SVG'),
  ];
}

// ─── Bootstrap 5 Layout Snippets ──────────────────────────────────────────

function getBootstrapLayoutSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    snip(monaco, 'container', '<div class="container">\n\t$0\n</div>', 'BS5 container', 'Bootstrap fixed container'),
    snip(monaco, 'container-fluid', '<div class="container-fluid">\n\t$0\n</div>', 'BS5 container-fluid', 'Full-width container'),
    snip(monaco, 'row', '<div class="row">\n\t$0\n</div>', 'BS5 row', 'Grid row'),
    snip(monaco, 'col', '<div class="col">\n\t$0\n</div>', 'BS5 col', 'Auto-size column'),
    snip(monaco, 'col-md', '<div class="col-12 col-md-${1:6}">\n\t$0\n</div>', 'BS5 col-md', 'Responsive column'),
    snip(monaco, 'col-layout-2', '<div class="row">\n\t<div class="col-12 col-md-6">\n\t\t$1\n\t</div>\n\t<div class="col-12 col-md-6">\n\t\t$2\n\t</div>\n</div>', 'BS5 2-col layout', '2-column responsive layout'),
    snip(monaco, 'col-layout-3', '<div class="row">\n\t<div class="col-12 col-md-4">$1</div>\n\t<div class="col-12 col-md-4">$2</div>\n\t<div class="col-12 col-md-4">$3</div>\n</div>', 'BS5 3-col layout', '3-column responsive layout'),
    snip(monaco, 'col-layout-sidebar', '<div class="row">\n\t<div class="col-12 col-md-3"><aside>$1</aside></div>\n\t<div class="col-12 col-md-9"><main>$2</main></div>\n</div>', 'BS5 sidebar layout', 'Sidebar + main layout'),
  ];
}

// ─── Bootstrap 5 Component Snippets ───────────────────────────────────────

function getBootstrapComponentSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    snip(monaco, 'navbar', '<nav class="navbar navbar-expand-lg bg-${1:dark}" data-bs-theme="${1:dark}">\n\t<div class="container-fluid">\n\t\t<a class="navbar-brand" href="#">${2:Brand}</a>\n\t\t<button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav"><span class="navbar-toggler-icon"></span></button>\n\t\t<div class="collapse navbar-collapse" id="navbarNav">\n\t\t\t<ul class="navbar-nav ms-auto">\n\t\t\t\t<li class="nav-item"><a class="nav-link active" href="#">${3:Home}</a></li>\n\t\t\t\t<li class="nav-item"><a class="nav-link" href="#">${4:About}</a></li>\n\t\t\t</ul>\n\t\t</div>\n\t</div>\n</nav>', 'BS5 Navbar', 'Bootstrap 5 responsive navbar'),
    snip(monaco, 'card', '<div class="card">\n\t<img src="${1:img.jpg}" class="card-img-top" alt="${2:}">\n\t<div class="card-body">\n\t\t<h5 class="card-title">${3:Card Title}</h5>\n\t\t<p class="card-text">${4:Content}</p>\n\t\t<a href="${5:#}" class="btn btn-primary">${6:Go}</a>\n\t</div>\n</div>', 'BS5 Card', 'Card with image'),
    snip(monaco, 'card-simple', '<div class="card">\n\t<div class="card-header">${1:Header}</div>\n\t<div class="card-body">\n\t\t<h5 class="card-title">${2:Title}</h5>\n\t\t<p class="card-text">${3:Content}</p>\n\t</div>\n\t<div class="card-footer text-muted">${4:Footer}</div>\n</div>', 'BS5 Card simple', 'Card header/body/footer'),
    snip(monaco, 'card-group', '<div class="row row-cols-1 row-cols-md-${1:3} g-4">\n\t<div class="col"><div class="card h-100"><div class="card-body"><h5 class="card-title">${2:Card 1}</h5><p class="card-text">$3</p></div></div></div>\n\t<div class="col"><div class="card h-100"><div class="card-body"><h5 class="card-title">${4:Card 2}</h5><p class="card-text">$5</p></div></div></div>\n</div>', 'BS5 Card group', 'Card group layout'),
    snip(monaco, 'modal', '<!-- Trigger -->\n<button type="button" class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#${1:myModal}">${2:Open Modal}</button>\n\n<!-- Modal -->\n<div class="modal fade" id="${1:myModal}" tabindex="-1">\n\t<div class="modal-dialog">\n\t\t<div class="modal-content">\n\t\t\t<div class="modal-header">\n\t\t\t\t<h5 class="modal-title">${3:Modal Title}</h5>\n\t\t\t\t<button type="button" class="btn-close" data-bs-dismiss="modal"></button>\n\t\t\t</div>\n\t\t\t<div class="modal-body">$4</div>\n\t\t\t<div class="modal-footer">\n\t\t\t\t<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>\n\t\t\t\t<button type="button" class="btn btn-primary">Save</button>\n\t\t\t</div>\n\t\t</div>\n\t</div>\n</div>', 'BS5 Modal', 'Modal with trigger'),
    snip(monaco, 'alert', '<div class="alert alert-${1:success} alert-dismissible fade show" role="alert">\n\t${2:Alert message}\n\t<button type="button" class="btn-close" data-bs-dismiss="alert"></button>\n</div>', 'BS5 Alert', 'Dismissible alert'),
    snip(monaco, 'btn', '<button type="${1:button}" class="btn btn-${2:primary}">${3:Button}</button>', 'BS5 Button', 'Bootstrap button'),
    snip(monaco, 'btn-group', '<div class="btn-group" role="group">\n\t<button type="button" class="btn btn-${1:primary}">${2:Left}</button>\n\t<button type="button" class="btn btn-${1:primary}">${3:Right}</button>\n</div>', 'BS5 Btn group', 'Button group'),
    snip(monaco, 'badge', '<span class="badge bg-${1:primary}">${2:New}</span>', 'BS5 Badge', 'Badge'),
    snip(monaco, 'breadcrumb', '<nav aria-label="breadcrumb">\n\t<ol class="breadcrumb">\n\t\t<li class="breadcrumb-item"><a href="#">${1:Home}</a></li>\n\t\t<li class="breadcrumb-item active" aria-current="page">${2:Current}</li>\n\t</ol>\n</nav>', 'BS5 Breadcrumb', 'Breadcrumb'),
    snip(monaco, 'pagination', '<nav aria-label="Page navigation">\n\t<ul class="pagination">\n\t\t<li class="page-item"><a class="page-link" href="#">Prev</a></li>\n\t\t<li class="page-item"><a class="page-link" href="#">1</a></li>\n\t\t<li class="page-item"><a class="page-link" href="#">Next</a></li>\n\t</ul>\n</nav>', 'BS5 Pagination', 'Pagination'),
    snip(monaco, 'accordion', '<div class="accordion" id="${1:accordion}">\n\t<div class="accordion-item">\n\t\t<h2 class="accordion-header">\n\t\t\t<button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#collapse${2:One}">${3:Item 1}</button>\n\t\t</h2>\n\t\t<div id="collapse${2:One}" class="accordion-collapse collapse show" data-bs-parent="#${1:accordion}">\n\t\t\t<div class="accordion-body">${4:Content}</div>\n\t\t</div>\n\t</div>\n</div>', 'BS5 Accordion', 'Accordion'),
    snip(monaco, 'tabs', '<ul class="nav nav-tabs" id="${1:myTab}">\n\t<li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#tab${2:One}">${3:Tab 1}</button></li>\n\t<li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab${4:Two}">${5:Tab 2}</button></li>\n</ul>\n<div class="tab-content">\n\t<div class="tab-pane fade show active" id="tab${2:One}">${6:Content 1}</div>\n\t<div class="tab-pane fade" id="tab${4:Two}">${7:Content 2}</div>\n</div>', 'BS5 Tabs', 'Tabs with content'),
    snip(monaco, 'dropdown', '<div class="dropdown">\n\t<button class="btn btn-${1:secondary} dropdown-toggle" type="button" data-bs-toggle="dropdown">${2:Dropdown}</button>\n\t<ul class="dropdown-menu">\n\t\t<li><a class="dropdown-item" href="#">${3:Action 1}</a></li>\n\t\t<li><a class="dropdown-item" href="#">${4:Action 2}</a></li>\n\t</ul>\n</div>', 'BS5 Dropdown', 'Dropdown menu'),
    snip(monaco, 'form-bs', '<form>\n\t<div class="mb-3">\n\t\t<label for="${1:email}" class="form-label">${2:Email}</label>\n\t\t<input type="${3:email}" class="form-control" id="${1:email}" placeholder="${4:Enter email}">\n\t</div>\n\t<button type="submit" class="btn btn-primary">${5:Submit}</button>\n</form>', 'BS5 Form', 'Bootstrap form'),
    snip(monaco, 'form-floating', '<div class="form-floating mb-3">\n\t<input type="${1:email}" class="form-control" id="${2:fi}" placeholder="${3:name@example.com}">\n\t<label for="${2:fi}">${4:Email}</label>\n</div>', 'BS5 Float label', 'Floating label input'),
    snip(monaco, 'input-group', '<div class="input-group mb-3">\n\t<span class="input-group-text">${1:@}</span>\n\t<input type="text" class="form-control" placeholder="${2:Username}">\n</div>', 'BS5 Input group', 'Input with addon'),
    snip(monaco, 'form-check', '<div class="form-check">\n\t<input class="form-check-input" type="${1:checkbox}" id="${2:c1}">\n\t<label class="form-check-label" for="${2:c1}">${3:Check this box}</label>\n</div>', 'BS5 Form check', 'Checkbox / radio'),
    snip(monaco, 'form-select', '<select class="form-select">\n\t<option selected>-- Select --</option>\n\t<option value="${1:1}">${2:Option 1}</option>\n\t<option value="${3:2}">${4:Option 2}</option>\n</select>', 'BS5 Form select', 'Styled select dropdown'),
    snip(monaco, 'table-bs', '<div class="table-responsive">\n\t<table class="table table-striped table-hover table-bordered">\n\t\t<thead class="table-dark"><tr><th>#</th><th>${1:Col 1}</th><th>${2:Col 2}</th></tr></thead>\n\t\t<tbody><tr><th scope="row">1</th><td>${3:Data}</td><td>${4:Data}</td></tr></tbody>\n\t</table>\n</div>', 'BS5 Table', 'Striped responsive table'),
    snip(monaco, 'spinner', '<div class="spinner-border text-${1:primary}" role="status">\n\t<span class="visually-hidden">Loading...</span>\n</div>', 'BS5 Spinner', 'Loading spinner'),
    snip(monaco, 'progress', '<div class="progress" style="height: ${1:20px};">\n\t<div class="progress-bar bg-${2:primary}" role="progressbar" style="width: ${3:50}%;" aria-valuenow="${3:50}" aria-valuemin="0" aria-valuemax="100">${3:50}%</div>\n</div>', 'BS5 Progress', 'Progress bar'),
    snip(monaco, 'toast', '<div class="toast-container position-fixed bottom-0 end-0 p-3">\n\t<div id="${1:myToast}" class="toast" role="alert">\n\t\t<div class="toast-header"><strong class="me-auto">${2:Title}</strong><button type="button" class="btn-close" data-bs-dismiss="toast"></button></div>\n\t\t<div class="toast-body">${3:Toast message}</div>\n\t</div>\n</div>', 'BS5 Toast', 'Toast notification'),
    snip(monaco, 'offcanvas', '<button class="btn btn-primary" type="button" data-bs-toggle="offcanvas" data-bs-target="#${1:oc}">${2:Open}</button>\n<div class="offcanvas offcanvas-${3:start}" id="${1:oc}">\n\t<div class="offcanvas-header">\n\t\t<h5 class="offcanvas-title">${4:Title}</h5>\n\t\t<button type="button" class="btn-close" data-bs-dismiss="offcanvas"></button>\n\t</div>\n\t<div class="offcanvas-body">$5</div>\n</div>', 'BS5 Offcanvas', 'Sliding offcanvas panel'),
    snip(monaco, 'hero', '<div class="px-4 py-5 text-center">\n\t<h1 class="display-5 fw-bold">${1:Hero Title}</h1>\n\t<div class="col-lg-6 mx-auto">\n\t\t<p class="lead mb-4">${2:Subtitle.}</p>\n\t\t<button type="button" class="btn btn-primary btn-lg">${3:Get Started}</button>\n\t</div>\n</div>', 'BS5 Hero', 'Hero / jumbotron section'),
    snip(monaco, 'list-group', '<ul class="list-group">\n\t<li class="list-group-item active">${1:Active item}</li>\n\t<li class="list-group-item">${2:Item 2}</li>\n\t<li class="list-group-item">${3:Item 3}</li>\n</ul>', 'BS5 List group', 'Bootstrap list group'),
    snip(monaco, 'carousel', '<div id="${1:myCarousel}" class="carousel slide" data-bs-ride="carousel">\n\t<div class="carousel-inner">\n\t\t<div class="carousel-item active"><img src="${2:s1.jpg}" class="d-block w-100" alt="${3:Slide 1}"></div>\n\t\t<div class="carousel-item"><img src="${4:s2.jpg}" class="d-block w-100" alt="${5:Slide 2}"></div>\n\t</div>\n\t<button class="carousel-control-prev" type="button" data-bs-target="#${1:myCarousel}" data-bs-slide="prev"><span class="carousel-control-prev-icon"></span></button>\n\t<button class="carousel-control-next" type="button" data-bs-target="#${1:myCarousel}" data-bs-slide="next"><span class="carousel-control-next-icon"></span></button>\n</div>', 'BS5 Carousel', 'Image carousel'),
  ];
}

// ─── Bootstrap 5 Class Completions ────────────────────────────────────────

function getBootstrapClassCompletions(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const e: Array<[string, string]> = [
    ['container', 'Fixed-width container'], ['container-fluid', 'Full-width container'],
    ['row', 'Grid row'], ['col', 'Auto column'],
    ['col-1', '1/12'], ['col-2', '2/12'], ['col-3', '3/12'], ['col-4', '4/12'],
    ['col-5', '5/12'], ['col-6', 'half'], ['col-7', '7/12'], ['col-8', '8/12'],
    ['col-9', '9/12'], ['col-10', '10/12'], ['col-11', '11/12'], ['col-12', 'full row'],
    ['col-sm-6', 'half on sm+'], ['col-md-4', 'third on md+'], ['col-md-6', 'half on md+'], ['col-lg-3', 'quarter on lg+'],
    ['g-0', 'no gutters'], ['g-1', 'gutter 1'], ['g-2', 'gutter 2'], ['g-3', 'gutter 3'], ['g-4', 'gutter 4'], ['g-5', 'gutter 5'],
    ['offset-md-3', 'offset 3 on md+'], ['gx-3', 'horizontal gutter 3'], ['gy-3', 'vertical gutter 3'],
    ['d-none', 'display:none'], ['d-block', 'display:block'], ['d-inline', 'display:inline'],
    ['d-inline-block', 'display:inline-block'], ['d-flex', 'display:flex'], ['d-inline-flex', 'display:inline-flex'],
    ['d-grid', 'display:grid'], ['d-md-none', 'hidden md+'], ['d-lg-none', 'hidden lg+'], ['d-lg-block', 'block lg+'],
    ['flex-row', 'direction:row'], ['flex-column', 'direction:column'],
    ['flex-wrap', 'flex-wrap:wrap'], ['flex-nowrap', 'flex-wrap:nowrap'],
    ['flex-grow-1', 'flex-grow:1'], ['flex-shrink-0', 'flex-shrink:0'], ['flex-fill', 'flex:1 1 auto'],
    ['justify-content-start', 'justify-start'], ['justify-content-end', 'justify-end'],
    ['justify-content-center', 'justify-center'], ['justify-content-between', 'space-between'],
    ['justify-content-around', 'space-around'], ['justify-content-evenly', 'evenly'],
    ['align-items-start', 'align start'], ['align-items-end', 'align end'],
    ['align-items-center', 'align center'], ['align-items-stretch', 'align stretch'],
    ['align-self-center', 'self center'], ['ms-auto', 'margin-left:auto'],
    ['me-auto', 'margin-right:auto'], ['mx-auto', 'center horizontally'],
    ['gap-0', 'gap 0'], ['gap-1', 'gap .25rem'], ['gap-2', 'gap .5rem'],
    ['gap-3', 'gap 1rem'], ['gap-4', 'gap 1.5rem'], ['gap-5', 'gap 3rem'],
    ['vstack', 'vertical flex stack'], ['hstack', 'horizontal flex stack'],
    ['m-0', 'm:0'], ['m-1', 'm:.25rem'], ['m-2', 'm:.5rem'], ['m-3', 'm:1rem'], ['m-4', 'm:1.5rem'], ['m-5', 'm:3rem'],
    ['mb-1', 'mb:.25rem'], ['mb-2', 'mb:.5rem'], ['mb-3', 'mb:1rem'], ['mb-4', 'mb:1.5rem'], ['mb-5', 'mb:3rem'],
    ['mt-1', 'mt:.25rem'], ['mt-2', 'mt:.5rem'], ['mt-3', 'mt:1rem'], ['mt-4', 'mt:1.5rem'], ['mt-5', 'mt:3rem'],
    ['ms-1', 'ml:.25rem'], ['me-1', 'mr:.25rem'],
    ['p-0', 'p:0'], ['p-1', 'p:.25rem'], ['p-2', 'p:.5rem'], ['p-3', 'p:1rem'], ['p-4', 'p:1.5rem'], ['p-5', 'p:3rem'],
    ['px-3', 'px:1rem'], ['py-3', 'py:1rem'], ['pt-3', 'pt:1rem'], ['pb-3', 'pb:1rem'],
    ['text-start', 'text-left'], ['text-center', 'text-center'], ['text-end', 'text-right'],
    ['text-primary', 'primary color'], ['text-secondary', 'grey'], ['text-success', 'green'],
    ['text-danger', 'red'], ['text-warning', 'yellow'], ['text-info', 'cyan'],
    ['text-muted', 'muted'], ['text-white', 'white'], ['text-dark', 'dark'],
    ['fw-bold', 'bold'], ['fw-normal', 'normal'], ['fw-light', 'light'], ['fw-semibold', '600'], ['fst-italic', 'italic'],
    ['fs-1', '2.5rem'], ['fs-2', '2rem'], ['fs-3', '1.75rem'], ['fs-4', '1.5rem'], ['fs-5', '1.25rem'], ['fs-6', '1rem'],
    ['text-truncate', 'ellipsis'], ['text-nowrap', 'nowrap'], ['text-uppercase', 'UPPERCASE'],
    ['text-lowercase', 'lowercase'], ['text-capitalize', 'Capitalize'], ['text-decoration-none', 'no underline'],
    ['display-1', '5rem'], ['display-2', '4.5rem'], ['display-3', '4rem'],
    ['display-4', '3.5rem'], ['display-5', '3rem'], ['display-6', '2.5rem'],
    ['lead', 'lead paragraph'], ['lh-1', 'line-height 1'], ['lh-base', 'line-height 1.5'],
    ['bg-primary', 'bg blue'], ['bg-secondary', 'bg grey'], ['bg-success', 'bg green'], ['bg-danger', 'bg red'],
    ['bg-warning', 'bg yellow'], ['bg-info', 'bg cyan'], ['bg-light', 'bg light'],
    ['bg-dark', 'bg dark'], ['bg-white', 'bg white'], ['bg-transparent', 'transparent'],
    ['bg-gradient', 'gradient overlay'], ['bg-opacity-25', '25% opacity'], ['bg-opacity-50', '50% opacity'],
    ['border', 'add border'], ['border-0', 'no border'], ['border-top', 'top border'], ['border-bottom', 'bottom border'],
    ['border-primary', 'border primary'], ['border-danger', 'border danger'],
    ['border-1', '1px'], ['border-2', '2px'], ['border-3', '3px'],
    ['rounded', 'radius .375rem'], ['rounded-0', 'no radius'], ['rounded-3', 'radius .5rem'],
    ['rounded-4', 'radius 1rem'], ['rounded-5', 'radius 2rem'], ['rounded-circle', 'circle'], ['rounded-pill', 'pill'],
    ['shadow', 'medium shadow'], ['shadow-sm', 'small shadow'], ['shadow-lg', 'large shadow'], ['shadow-none', 'no shadow'],
    ['w-25', 'width 25%'], ['w-50', 'width 50%'], ['w-75', 'width 75%'], ['w-100', 'width 100%'], ['w-auto', 'width auto'],
    ['h-25', 'height 25%'], ['h-50', 'height 50%'], ['h-75', 'height 75%'], ['h-100', 'height 100%'],
    ['mw-100', 'max-width 100%'], ['min-vh-100', 'min-height 100vh'], ['vh-100', 'height 100vh'],
    ['position-relative', 'relative'], ['position-absolute', 'absolute'],
    ['position-fixed', 'fixed'], ['position-sticky', 'sticky'],
    ['top-0', 'top 0'], ['bottom-0', 'bottom 0'], ['start-0', 'left 0'], ['end-0', 'right 0'],
    ['top-50', 'top 50%'], ['start-50', 'left 50%'], ['translate-middle', 'center both axes'],
    ['overflow-auto', 'overflow auto'], ['overflow-hidden', 'overflow hidden'], ['overflow-scroll', 'overflow scroll'],
    ['visible', 'visible'], ['invisible', 'invisible'], ['visually-hidden', 'screen-reader only'],
    ['z-0', 'z 0'], ['z-1', 'z 1'], ['z-n1', 'z -1'],
    ['object-fit-cover', 'cover'], ['object-fit-contain', 'contain'], ['img-fluid', 'responsive'], ['img-thumbnail', 'thumbnail'],
    ['btn', 'button base'], ['btn-primary', 'blue'], ['btn-secondary', 'grey'], ['btn-success', 'green'],
    ['btn-danger', 'red'], ['btn-warning', 'yellow'], ['btn-info', 'cyan'], ['btn-light', 'light'],
    ['btn-dark', 'dark'], ['btn-link', 'link style'],
    ['btn-outline-primary', 'outline blue'], ['btn-outline-secondary', 'outline grey'],
    ['btn-outline-danger', 'outline red'], ['btn-outline-success', 'outline green'],
    ['btn-sm', 'small'], ['btn-lg', 'large'], ['btn-close', '× close button'],
    ['nav-link', 'nav link'], ['nav-tabs', 'tab style'], ['nav-pills', 'pill style'],
    ['navbar', 'navbar wrapper'], ['navbar-brand', 'brand'], ['navbar-nav', 'nav list'],
    ['navbar-toggler', 'hamburger'], ['navbar-expand-lg', 'expand at lg'],
    ['navbar-dark', 'dark theme'], ['navbar-light', 'light theme'],
    ['collapse', 'collapse'], ['navbar-collapse', 'collapsible navbar content'],
    ['card', 'card'], ['card-body', 'body'], ['card-title', 'title'], ['card-text', 'text'],
    ['card-header', 'header'], ['card-footer', 'footer'], ['card-img-top', 'img top'],
    ['alert', 'alert'], ['alert-primary', 'blue'], ['alert-success', 'green'],
    ['alert-danger', 'red'], ['alert-warning', 'yellow'], ['alert-info', 'cyan'],
    ['alert-dismissible', 'closeable'], ['fade', 'fade'], ['show', 'show'],
    ['badge', 'badge'],
    ['table', 'table'], ['table-striped', 'striped'], ['table-hover', 'hover'],
    ['table-bordered', 'bordered'], ['table-borderless', 'no border'],
    ['table-responsive', 'responsive scroll'], ['table-dark', 'dark'], ['table-sm', 'compact'],
    ['form-control', 'input control'], ['form-label', 'label'], ['form-text', 'help text'],
    ['form-select', 'styled select'], ['form-check', 'checkbox wrapper'],
    ['form-check-input', 'checkbox/radio input'], ['form-check-label', 'label'],
    ['form-switch', 'toggle switch'], ['form-floating', 'floating label'],
    ['input-group', 'input with addon'], ['input-group-text', 'addon text'],
    ['is-valid', 'valid state'], ['is-invalid', 'invalid state'],
    ['valid-feedback', 'success message'], ['invalid-feedback', 'error message'],
    ['list-group', 'list group'], ['list-group-item', 'list item'],
    ['modal', 'modal'], ['modal-dialog', 'dialog'], ['modal-content', 'content'],
    ['modal-header', 'header'], ['modal-body', 'body'], ['modal-footer', 'footer'],
    ['modal-lg', 'large'], ['modal-sm', 'small'], ['modal-fullscreen', 'fullscreen'],
    ['accordion', 'accordion'], ['accordion-item', 'item'],
    ['accordion-button', 'toggle button'], ['accordion-body', 'content'],
    ['progress', 'progress wrapper'], ['progress-bar', 'progress fill'],
    ['spinner-border', 'circular spinner'], ['spinner-grow', 'grow spinner'],
    ['pagination', 'pagination'], ['page-item', 'page item'], ['page-link', 'page link'],
    ['dropdown', 'dropdown'], ['dropdown-menu', 'menu'], ['dropdown-item', 'item'], ['dropdown-toggle', 'trigger'],
    ['toast', 'toast'], ['offcanvas', 'offcanvas'], ['offcanvas-start', 'from left'], ['offcanvas-end', 'from right'],
    ['ratio-16x9', '16:9 aspect'], ['ratio-4x3', '4:3 aspect'], ['ratio-1x1', '1:1 aspect'],
    ['stretched-link', 'clickable parent'], ['user-select-none', 'no text select'],
    ['pe-none', 'no pointer-events'], ['clearfix', 'float clearfix'],
    ['float-start', 'float left'], ['float-end', 'float right'], ['cursor-pointer', 'cursor pointer'],
  ];
  return e.map(([label, doc]) => bsCls(monaco, label, doc));
}

// ─── Public Export ─────────────────────────────────────────────────────────

export function getHtmlCompletions(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  return [
    ...getHtml5Snippets(monaco),
    ...getHtmlFormSnippets(monaco),
    ...getHtmlTableSnippets(monaco),
    ...getHtmlMediaSnippets(monaco),
    ...getBootstrapLayoutSnippets(monaco),
    ...getBootstrapComponentSnippets(monaco),
    ...getBootstrapClassCompletions(monaco),
  ];
}
