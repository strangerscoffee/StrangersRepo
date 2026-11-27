"""Build the consumer editor's fixed selector inventory from the shipped retail HTML."""
import argparse
from dataclasses import dataclass, field
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
import re

BASE = Path(__file__).resolve().parents[1] / 'public' / 'consumer-preview'
ASSETS = BASE / 'assets'
# Direct child sections, stable identifiers, and layout roots for each storefront page.
PAGES = {
    'home': ('Home', '', 'main', [('hero', 'Hero', '#top'), ('featured', 'On the roaster', '#coffee'), ('visit', 'Visit the roastery', '#visit'), ('social', 'Instagram', '.home-social-section')]),
    'shop': ('Online shop', 'coffee', 'main', [('hero', 'Shop introduction', '.shop-hero'), ('catalogue', 'Coffee catalogue', '#coffee'), ('information', 'Gifts and shop information', '.shop-information')]),
    'locations': ('Locations', 'location', 'main', [('intro', 'Introduction', '.visit-intro'), ('locations', 'Café locations', '.visit-list'), ('story', 'Coffee in Norwich', '.editorial-reading')]),
    'about': ('About', 'about', 'main', [('intro', 'Introduction', '.editorial-masthead'), ('story', 'Our story', '.about-story'), ('links', 'Explore more', '.editorial-next')]),
    'guides': ('Brew guides', 'brewguides', 'main', [('intro', 'Introduction', '.brew-intro'), ('recipes', 'Brewing recipes', '.recipe-list')]),
    'contact': ('Contact', 'contact', '.support-page', [('contact', 'Contact and enquiry form', '.support-contact-layout'), ('links', 'More help', '.support-related')]),
    'shipping': ('Shipping & returns', 'shipping', '.support-page', [('intro', 'Introduction', '.support-policy-heading'), ('quick-links', 'Quick links', '.support-quick-links'), ('note', 'Preview notice', '.support-preview-note'), ('policy', 'Shipping policy', '.support-policy-layout'), ('links', 'More help', '.support-related')]),
    'privacy': ('Privacy policy', 'privacy-policy', '.support-page', [('intro', 'Introduction', '.support-policy-heading'), ('note', 'Preview notice', '.support-preview-note'), ('policy', 'Privacy policy', '.support-policy-layout'), ('links', 'More help', '.support-related')]),
    'terms': ('Terms & conditions', 'terms-conditions', '.support-page', [('intro', 'Introduction', '.support-policy-heading'), ('quick-links', 'Quick links', '.support-quick-links'), ('note', 'Preview notice', '.support-preview-note'), ('policy', 'Terms', '.support-policy-copy'), ('links', 'More help', '.support-related')]),
    'account': ('My account', 'account', '#account-page', [('hero', 'Account introduction', '.account-hero'), ('access', 'Sign-in and account access', '#account-access'), ('dashboard', 'Account and orders', '#account-dashboard')]),
    'checkout': ('Checkout', 'checkout', 'main', [('heading', 'Checkout header', '.retail-checkout-heading'), ('checkout', 'Checkout form and tracking', '#retail-checkout')]),
}
LOCKED = {'catalogue', 'contact', 'checkout', 'access', 'dashboard', 'policy', 'note'}
VOID = set('area base br col embed hr img input link meta param source track wbr'.split())
TEXT = set('h1 h2 h3 h4 h5 p summary figcaption dt dd li a button label legend'.split())
INLINE = set('em i strong b span small br abbr code'.split())
SKIP = {'script','style','template','noscript','svg','input','output','select','textarea','address'}
# Stock/price, live social posts, personal information, transactional feedback and notices belong to the application.
IGNORE_ID = {'home-roasting-grid','home-social-posts','products','shelf-status','account-access-status','account-title',
             'account-access-title','account-access-copy','account-hero-label','account-auth','account-order-history',
             'account-saved-address','account-save-status','account-dashboard-status','account-edit-address',
             'retail-checkout-heading','account-help-copy','contact-status','account-no-address','account-profile-hint'}
IGNORE_CLASS = {'support-preview-note', 'shop-gift-price', 'gift-price', 'form-error'}

@dataclass
class Node:
    tag: str
    attrs: dict
    parent: 'Node | None' = None
    children: list = field(default_factory=list)
    def elements(self):
        return [n for n in self.children if isinstance(n, Node)]
    def text(self):
        return ''.join(n.text() if isinstance(n, Node) else n for n in self.children)

class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.current = Node('document', {})
        self.all = []
    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs), self.current)
        self.current.children.append(node)
        self.all.append(node)
        if tag not in VOID:
            self.current = node
    def handle_endtag(self, tag):
        n = self.current
        while n.parent and n.tag != tag:
            n = n.parent
        if n.parent:
            self.current = n.parent
    def handle_data(self, data):
        self.current.children.append(data)

def matches(n, selector):
    if selector[0] == '.':
        return selector[1:] in n.attrs.get('class','').split()
    if selector[0] == '#':
        return n.attrs.get('id') == selector[1:]
    return n.tag == selector

def simple(n, parent):
    identifier = n.attrs.get('id', '')
    if re.fullmatch('[a-zA-Z][a-zA-Z0-9_-]*', identifier):
        return '#' + identifier, True
    siblings = parent.elements()
    for cls in n.attrs.get('class','').split():
        if re.fullmatch('[a-zA-Z][a-zA-Z0-9_-]*',cls) and sum(cls in v.attrs.get('class','').split() for v in siblings) == 1:
            return '.' + cls, False
    group = [v for v in siblings if v.tag == n.tag]
    index = next(i for i,v in enumerate(group,1) if v is n)
    return n.tag + (f':nth-of-type({index})' if len(group) > 1 else ''), False

def walk(n, selector, section, fields, page, product_anchor=None):
    if product_id := n.attrs.get('data-catalogue-id'):
        product_anchor = (selector, '[data-catalogue-id="' + product_id + '"]')
    if n.tag in SKIP or n.attrs.get('id') in IGNORE_ID or any(c in IGNORE_CLASS for c in n.attrs.get('class','').split()):
        return
    if n.attrs.get('role') in ('status','alert') or n.attrs.get('aria-live') or 'data-cart-message' in n.attrs:
        return
    value = ' '.join(n.text().split())
    def add(kind, default, name):
        explicit = n.attrs.get('id') if kind == 'text' else None
        id = explicit or kind + '-' + sha256(selector.encode()).hexdigest()[:12]
        # Historical IDs come from the original markup. Target the product itself
        # on live shelves, whose position changes whenever the catalogue changes.
        target = selector.replace(*product_anchor, 1) if product_anchor else selector
        fields.append(dict(id=id, label=name, selector=target, kind=kind, default=default, section=section))
    if n.tag == 'img' and n.attrs.get('src','').startswith('/consumer-preview/assets/'):
        filename = n.attrs['src'].split('/')[-1]
        label = n.attrs.get('alt') or filename.split('.')[0].replace('-',' ').capitalize()
        add('image','asset:' + filename,label[:100])
        add('alt',n.attrs.get('alt',''),label[:80]+' · alternative text')
    if n.tag == 'a' and n.attrs.get('href') and page not in ('checkout','account'):
        add('link',n.attrs['href'],(value[:60] or n.attrs.get('aria-label','') or 'Photo')+' · link')
    if (n.tag in TEXT and value and all(c.tag in INLINE for c in n.elements())
        and not any(ch.tag in ('a','button','input','select') for ch in n.elements()) and not value.startswith('From £')
        and not (n.tag == 'button' and page in ('checkout','account'))):
        add('text',value,value[:84] + ('…' if len(value)>84 else ''))
        return
    for child in n.elements():
        part, absolute = simple(child, n)
        child_selector = part if absolute else selector + ' > ' + part
        walk(child, child_selector, section, fields, page, product_anchor)

def inventory():
    result = {}
    for page,(label, directory, root, definitions) in PAGES.items():
        tree = Tree()
        tree.feed((BASE / directory / 'index.html').read_text())
        container = next(n for n in tree.all if matches(n,root))
        sections, fields = [], []
        for id, title, sel in definitions:
            node = next(n for n in container.elements() if matches(n,sel))
            locked = id in LOCKED or (page,id) in {('account','hero'),('checkout','heading')}
            sections.append(dict(id=id,label=title,selector=sel,locked=locked))
            # Anchor selectors to a named native block so reordering never retargets an edit.
            walk(node,sel,id,fields,page)
        assert len({f['id'] for f in fields}) == len(fields), page
        result[page] = dict(label=label,path='/'+(directory+'/' if directory else ''),root=root,sections=sections,fields=fields)
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check',action='store_true')
    args = parser.parse_args()
    lines = ['// Generated by scripts/consumer-editor-inventory.py from the storefront HTML.',
             'export const assetFiles = '+json.dumps(sorted(p.name for p in ASSETS.iterdir() if p.suffix in ('.svg','.webp')))+';',
             'export const staticPages = {']
    for key, page in inventory().items():
        fields = page.pop('fields')
        lines.append(json.dumps(key)+': {'+json.dumps(page,ensure_ascii=False)[1:-1]+', "fields": [')
        lines.extend(json.dumps(field,ensure_ascii=False) + ',' for field in fields)
        lines.append(']},')
    lines.append('};')
    text = '\n'.join(lines)+'\n'
    target = ASSETS / 'editor-inventory.js'
    if args.check:
        if target.read_text() != text:
            raise SystemExit('Storefront editing inventory is stale. Run python3 scripts/consumer-editor-inventory.py')
    else:
        target.write_text(text)
