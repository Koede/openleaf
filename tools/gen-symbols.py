#!/usr/bin/env python3
"""Generates public/symbols/{symbols.json,sprite.png}.

Every symbol is typeset by the local LaTeX install (preview.sty, one page per symbol), rasterised with
pdftoppm, thinned to a skeleton and stored as a small normalised point set. The browser matches a hand
drawing against those point sets (chamfer distance) -> offline "Detexify".  Run: python3 tools/gen-symbols.py
"""
import json, math, os, re, subprocess, sys, tempfile, shutil
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'symbols')
DPI = 320            # 10pt text ~ 44px => 22px at 1x in the 2x sprite
CELL_W, CELL_H = 96, 64
GRID = 20            # skeleton points are binned to a 20x20 grid

# ---- symbol table -------------------------------------------------------------------------------------
# (category, package, mode, items). item = "name" (-> \name) or (label, render, insert)
def W(s): return s.split()
T = []
def cat(name, pkg, mode, items): T.append((name, pkg, mode, items))

cat('Greek lowercase', '', 'math', W('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa varkappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega') + [r'\digamma'])
cat('Greek uppercase', '', 'math', W('Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'))
cat('Greek uppercase', 'amsmath', 'math', W('varGamma varDelta varTheta varLambda varXi varPi varSigma varUpsilon varPhi varPsi varOmega'))
cat('Binary operators', '', 'math', W('pm mp times div cdot ast star circ bullet cap cup uplus sqcap sqcup vee wedge setminus wr diamond bigtriangleup bigtriangledown triangleleft triangleright oplus ominus otimes oslash odot bigcirc dagger ddagger amalg'))
cat('Binary operators', 'amssymb', 'math', W('dotplus smallsetminus Cap Cup barwedge veebar doublebarwedge boxminus boxplus boxtimes boxdot divideontimes ltimes rtimes leftthreetimes rightthreetimes curlywedge curlyvee circleddash circledast circledcirc centerdot intercal'))
cat('Binary operators', 'latexsym', 'math', W('lhd rhd unlhd unrhd'))
cat('Binary operators', 'stmaryrd', 'math', W('oblong varoast varobar varodot varoslash varovee varowedge varotimes varcurlyvee varcurlywedge baro minuso sslash bigsqcap bigcurlyvee bigcurlywedge'))
cat('Relations', '', 'math', W('leq geq neq equiv sim simeq approx cong propto ll gg subset supset subseteq supseteq sqsubset sqsupset sqsubseteq sqsupseteq in ni notin vdash dashv models perp parallel mid asymp doteq bowtie smile frown prec succ preceq succeq'))
cat('Relations', 'amssymb', 'math', W('leqq geqq leqslant geqslant eqslantless eqslantgtr lesssim gtrsim lessapprox gtrapprox approxeq lessdot gtrdot lll ggg lessgtr gtrless lesseqgtr gtreqless lesseqqgtr gtreqqless doteqdot risingdotseq fallingdotseq backsim backsimeq subseteqq supseteqq Subset Supset curlyeqprec curlyeqsucc precsim succsim precapprox succapprox vartriangleleft vartriangleright trianglelefteq trianglerighteq vDash Vdash Vvdash smallsmile smallfrown bumpeq Bumpeq between pitchfork varpropto backepsilon blacktriangleleft blacktriangleright therefore because eqcirc circeq triangleq shortmid shortparallel'))
cat('Negated relations', 'amssymb', 'math', W('nmid nparallel nleq ngeq nless ngtr nleqslant ngeqslant nleqq ngeqq lneq gneq lneqq gneqq lnsim gnsim lnapprox gnapprox nprec nsucc npreceq nsucceq precneqq succneqq precnsim succnsim nsim ncong nvdash nvDash nVdash nVDash ntriangleleft ntriangleright ntrianglelefteq ntrianglerighteq nsubseteq nsupseteq nsubseteqq nsupseteqq subsetneq supsetneq subsetneqq supsetneqq varsubsetneq varsupsetneq'))
cat('Negated relations', '', 'math', [(r'\not=', r'\not=', r'\not='), (r'\not\equiv', r'\not\equiv', r'\not\equiv'), (r'\not\in', r'\not\in', r'\not\in'), (r'\not\subset', r'\not\subset', r'\not\subset')])
cat('Arrows', '', 'math', W('leftarrow rightarrow leftrightarrow Leftarrow Rightarrow Leftrightarrow longleftarrow longrightarrow longleftrightarrow Longleftarrow Longrightarrow Longleftrightarrow mapsto longmapsto hookleftarrow hookrightarrow leftharpoonup leftharpoondown rightharpoonup rightharpoondown rightleftharpoons uparrow downarrow updownarrow Uparrow Downarrow Updownarrow nearrow searrow swarrow nwarrow iff'))
cat('Arrows', 'amssymb', 'math', W('dashrightarrow dashleftarrow leftleftarrows leftrightarrows Lleftarrow twoheadleftarrow leftarrowtail looparrowleft leftrightharpoons curvearrowleft circlearrowleft Lsh upuparrows upharpoonleft downharpoonleft multimap leftrightsquigarrow rightrightarrows rightleftarrows Rrightarrow twoheadrightarrow rightarrowtail looparrowright curvearrowright circlearrowright Rsh downdownarrows upharpoonright downharpoonright rightsquigarrow nleftarrow nrightarrow nLeftarrow nRightarrow nleftrightarrow nLeftrightarrow'))
cat('Arrows', 'amsmath', 'math', [(r'\xrightarrow', r'\xrightarrow{abc}', r'\xrightarrow{‸}'), (r'\xleftarrow', r'\xleftarrow{abc}', r'\xleftarrow{‸}'), (r'\implies', r'A\implies B', r'\implies'), (r'\impliedby', r'A\impliedby B', r'\impliedby')])
cat('Arrows', 'mathtools', 'math', [(r'\xleftrightarrow', r'\xleftrightarrow{abc}', r'\xleftrightarrow{‸}'), (r'\xmapsto', r'\xmapsto{abc}', r'\xmapsto{‸}'), (r'\xhookrightarrow', r'\xhookrightarrow{abc}', r'\xhookrightarrow{‸}')])
cat('Miscellaneous', '', 'math', W('infty nabla partial forall exists emptyset neg lnot top bot angle triangle backslash hbar ell Re Im aleph wp imath jmath prime surd flat natural sharp clubsuit diamondsuit heartsuit spadesuit ldots cdots vdots ddots mho'))
cat('Miscellaneous', 'amssymb', 'math', W('nexists varnothing measuredangle sphericalangle beth gimel daleth blacksquare square lozenge blacklozenge bigstar circledS complement Finv Game eth checkmark maltese yen backprime vartriangle blacktriangle blacktriangledown triangledown Bbbk hslash'))
cat('Miscellaneous', 'latexsym', 'math', W('Box Diamond Join leadsto'))
cat('Miscellaneous', 'amsmath', 'math', [(r'\dots', r'a\dots b', r'\dots'), (r'\dotsb', r'a+\dotsb+b', r'\dotsb'), (r'\iddots', r'\ddots', r'\iddots') if False else (r'\boxed', r'\boxed{abc}', r'\boxed{‸}')])
cat('Big operators', '', 'math', W('sum prod coprod int oint bigcup bigcap bigsqcup bigvee bigwedge bigodot bigoplus bigotimes biguplus'))
cat('Big operators', 'amsmath', 'math', W('iint iiint iiiint idotsint'))
cat('Big operators', '', 'math', [(r'\lim', r'\lim_{x\to 0}', r'\lim_{x\to 0}'), (r'\limsup', r'\limsup_{n}', r'\limsup_{n\to\infty}'), (r'\liminf', r'\liminf_{n}', r'\liminf_{n\to\infty}'), (r'\max', r'\max_{x}', r'\max_{‸}'), (r'\min', r'\min_{x}', r'\min_{‸}'), (r'\sup', r'\sup_{x}', r'\sup_{‸}'), (r'\inf', r'\inf_{x}', r'\inf_{‸}')])
cat('Functions', '', 'math', [(r'\%s' % f, r'\%s x' % f, r'\%s' % f) for f in W('sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth exp ln log det dim ker deg gcd Pr arg hom')])
cat('Delimiters', '', 'math', [(r'\langle', r'\langle x\rangle', r'\langle ‸\rangle'), (r'\rangle', r'\langle x\rangle', r'\rangle'), (r'\lceil', r'\lceil x\rceil', r'\lceil ‸\rceil'), (r'\lfloor', r'\lfloor x\rfloor', r'\lfloor ‸\rfloor'), (r'\{ \}', r'\{x\}', r'\{‸\}'), (r'\vert', r'\vert x\vert', r'\vert'), (r'\Vert', r'\Vert x\Vert', r'\Vert'), (r'\lbrack', r'\lbrack x\rbrack', r'['), (r'\left( \right)', r'\left(\frac{a}{b}\right)', r'\left( ‸ \right)'), (r'\left[ \right]', r'\left[\frac{a}{b}\right]', r'\left[ ‸ \right]'), (r'\left\{ \right\}', r'\left\{\frac{a}{b}\right\}', r'\left\{ ‸ \right\}'), (r'\left\langle \right\rangle', r'\left\langle\frac{a}{b}\right\rangle', r'\left\langle ‸ \right\rangle'), (r'\left| \right|', r'\left|\frac{a}{b}\right|', r'\left| ‸ \right|'), (r'\left. \right|', r'\left.\frac{a}{b}\right|', r'\left. ‸ \right|')])
cat('Delimiters', 'amsmath', 'math', [(r'\lvert \rvert', r'\lvert x\rvert', r'\lvert ‸ \rvert'), (r'\lVert \rVert', r'\lVert x\rVert', r'\lVert ‸ \rVert')])
cat('Delimiters', 'stmaryrd', 'math', [(r'\llbracket \rrbracket', r'\llbracket x\rrbracket', r'\llbracket ‸ \rrbracket')])
cat('Accents & decorations', '', 'math', [(r'\%s' % a, r'\%s{x}' % a, r'\%s{‸}' % a) for a in W('hat widehat check tilde widetilde acute grave dot ddot breve bar vec overline underline overrightarrow overleftarrow mathring')] + [(r'\overbrace', r'\overbrace{abc}^{n}', r'\overbrace{‸}^{}'), (r'\underbrace', r'\underbrace{abc}_{n}', r'\underbrace{‸}_{}'), (r'\bar\psi', r'\bar\psi', r'\bar\psi')])
cat('Accents & decorations', 'amsmath', 'math', [(r'\dddot', r'\dddot{x}', r'\dddot{‸}'), (r'\overset', r'\overset{a}{=}', r'\overset{‸}{}'), (r'\underset', r'\underset{a}{=}', r'\underset{‸}{}'), (r'\stackrel', r'\stackrel{a}{=}', r'\stackrel{‸}{}')])
cat('Structures', '', 'math', [(r'\frac', r'\frac{a}{b}', r'\frac{‸}{}'), (r'\sqrt', r'\sqrt{x}', r'\sqrt{‸}'), (r'\sqrt[n]', r'\sqrt[n]{x}', r'\sqrt[‸]{}'), (r'x^{n}', r'x^{n}', r'^{‸}'), (r'x_{n}', r'x_{n}', r'_{‸}'), (r'\sum_{i}^{n}', r'\sum_{i=1}^{n}', r'\sum_{i=1}^{‸}'), (r'\int_a^b', r'\int_a^b f\,dx', r'\int_{‸}^{} \, dx'), (r'\prod_{i}^{n}', r'\prod_{i=1}^{n}', r'\prod_{i=1}^{‸}'), (r'\binom', r'\binom{n}{k}', r'\binom{‸}{}'), (r'\text', r'\text{abc}', r'\text{‸}'), (r'\mathrm', r'\mathrm{d}x', r'\mathrm{‸}'), (r'\mathbf', r'\mathbf{x}', r'\mathbf{‸}'), (r'\boldsymbol', r'\boldsymbol{\alpha}', r'\boldsymbol{‸}'), (r'\left\{ \begin{array}', r'\begin{cases}a\\b\end{cases}', r'\begin{cases}\n  ‸ & \text{if } \\\\\n   & \text{otherwise}\n\\end{cases}')])
cat('Math alphabets', 'amssymb', 'math', [(r'\mathbb{%s}' % c, r'\mathbb{%s}' % c, r'\mathbb{%s}' % c) for c in 'RCNZQHEP'] + [(r'\mathfrak{g}', r'\mathfrak{g}', r'\mathfrak{g}'), (r'\mathfrak{su}', r'\mathfrak{su}', r'\mathfrak{su}')])
cat('Math alphabets', '', 'math', [(r'\mathcal{%s}' % c, r'\mathcal{%s}' % c, r'\mathcal{%s}' % c) for c in 'LHOFNAZ'])
cat('Math alphabets', 'mathrsfs', 'math', [(r'\mathscr{%s}' % c, r'\mathscr{%s}' % c, r'\mathscr{%s}' % c) for c in 'LHF'])
cat('Text symbols', 'textcomp', 'text', [(r'\%s' % s, r'\%s' % s, r'\%s{}' % s) for s in W('textdegree textmu textpm texttimes textdiv textbullet textperiodcentered textcopyright textregistered texttrademark textsection textparagraph textdagger textdaggerdbl textellipsis textendash textemdash textless textgreater textbackslash textasciitilde textasciicircum textunderscore textbar textbraceleft textbraceright textdollar textcelsius textohm texteuro textsterling textyen textcent textonehalf textonequarter textthreequarters textperthousand textminus textsurd textnumero textlangle textrangle')] + [(c, c, c) for c in [r'\%', r'\&', r'\#', r'\_', r'\$', r'\{', r'\}', r'\ss', r'\ae', r'\oe', r'\o', r'\aa', r'\l', r'\AE', r'\OE', r'\O', r'\AA', r'\L', r'\i', r'\j']])

# popular search aliases (friendly names)
ALIASES = {
 'leq': 'less than or equal', 'geq': 'greater than or equal', 'neq': 'not equal unequal', 'infty': 'infinity', 'int': 'integral', 'oint': 'contour integral',
 'sum': 'summation sigma', 'prod': 'product', 'partial': 'partial derivative del', 'nabla': 'del gradient', 'forall': 'for all universal', 'exists': 'there exists',
 'in': 'element of member', 'notin': 'not element', 'subset': 'proper subset', 'subseteq': 'subset or equal', 'cap': 'intersection', 'cup': 'union', 'emptyset': 'empty set null',
 'rightarrow': 'right arrow to', 'leftarrow': 'left arrow', 'Rightarrow': 'implies double arrow', 'Leftrightarrow': 'if and only if iff', 'mapsto': 'maps to', 'to': 'arrow',
 'pm': 'plus minus', 'mp': 'minus plus', 'times': 'cross multiply', 'cdot': 'dot product multiply center dot', 'approx': 'approximately', 'equiv': 'equivalent congruent identical',
 'propto': 'proportional', 'hbar': 'planck reduced', 'ell': 'script l', 'dagger': 'dagger adjoint hermitian', 'otimes': 'tensor product kronecker', 'oplus': 'direct sum xor',
 'langle': 'bra angle bracket', 'rangle': 'ket angle bracket', 'ldots': 'ellipsis dots', 'cdots': 'ellipsis center dots', 'vdots': 'vertical dots', 'ddots': 'diagonal dots',
 'angle': 'angle', 'perp': 'perpendicular orthogonal', 'parallel': 'parallel', 'degree': 'degree', 'textdegree': 'degree', 'Re': 'real part', 'Im': 'imaginary part',
 'aleph': 'aleph cardinality', 'hat': 'hat caret', 'bar': 'bar overline conjugate', 'tilde': 'tilde', 'vec': 'vector', 'dot': 'time derivative', 'ddot': 'second derivative',
 'sqrt': 'square root radical', 'frac': 'fraction divide', 'lim': 'limit', 'therefore': 'therefore', 'because': 'because', 'checkmark': 'tick check', 'neg': 'not negation logical',
 'wedge': 'and logical wedge', 'vee': 'or logical', 'top': 'true top', 'bot': 'false bottom', 'vdash': 'proves turnstile', 'models': 'models satisfies', 'sim': 'similar tilde',
 'simeq': 'asymptotically equal', 'cong': 'congruent', 'gg': 'much greater', 'll': 'much less', 'ast': 'asterisk star', 'circ': 'composition circle', 'bullet': 'bullet dot',
 'mathbb': 'blackboard bold double struck', 'mathcal': 'calligraphic', 'mathfrak': 'fraktur', 'mathscr': 'script', 'bm': 'bold', 'varepsilon': 'epsilon', 'varphi': 'phi',
 'hookrightarrow': 'inclusion injection', 'twoheadrightarrow': 'surjection onto', 'rightleftharpoons': 'equilibrium reversible', 'textmu': 'micro', 'textohm': 'ohm', 'texteuro': 'euro currency',
}

# ---- Mathematica-style templates: every #{n} is a blank box the user types into next ----------------------
TPL = []
def tpl(cat, name, ins, mode='math', pkg=''): TPL.append(dict(cat=cat, n=name, i=ins, m=mode, pkg=pkg))
def mat(env, rows, cols):
    n = 0; lines = []
    for r in range(rows):
        cells = []
        for c in range(cols):
            n += 1; cells.append('#{%d}' % n)
        lines.append('\t' + ' & '.join(cells) + (r' \\' if r < rows - 1 else ''))
    return '\\begin{%s}\n' % env + '\n'.join(lines) + '\n\\end{%s}' % env

B = 'Basic'
tpl(B, 'Fraction', r'\frac{#{1}}{#{2}}'); tpl(B, 'Square root', r'\sqrt{#{1}}'); tpl(B, 'Nth root', r'\sqrt[#{1}]{#{2}}')
tpl(B, 'Power', r'#{1}^{#{2}}'); tpl(B, 'Subscript', r'#{1}_{#{2}}'); tpl(B, 'Subscript + superscript', r'#{1}_{#{2}}^{#{3}}')
tpl(B, 'Exponential', r'e^{#{1}}'); tpl(B, 'Binomial', r'\binom{#{1}}{#{2}}', pkg='amsmath')
tpl(B, 'Parentheses', r'\left( #{1} \right)'); tpl(B, 'Brackets', r'\left[ #{1} \right]'); tpl(B, 'Braces', r'\left\{ #{1} \right\}')
tpl(B, 'Angle brackets', r'\left\langle #{1} \right\rangle'); tpl(B, 'Absolute value', r'\left| #{1} \right|'); tpl(B, 'Norm', r'\left\| #{1} \right\|')
tpl(B, 'Floor', r'\left\lfloor #{1} \right\rfloor'); tpl(B, 'Ceiling', r'\left\lceil #{1} \right\rceil')
tpl(B, 'Log base', r'\log_{#{1}} #{2}'); tpl(B, 'Natural log', r'\ln\left( #{1} \right)')
tpl(B, 'Piecewise', '\\begin{cases}\n\t#{1} & #{2} \\\\\n\t#{3} & #{4}\n\\end{cases}', pkg='amsmath')

C = 'Calculus'
tpl(C, 'Derivative d/dx', r'\frac{\mathrm{d}#{1}}{\mathrm{d}#{2}}'); tpl(C, 'Derivative operator', r'\frac{\mathrm{d}}{\mathrm{d}#{1}}')
tpl(C, 'Nth derivative', r'\frac{\mathrm{d}^{#{3}}#{1}}{\mathrm{d}#{2}^{#{3}}}')
tpl(C, 'Partial derivative', r'\frac{\partial #{1}}{\partial #{2}}'); tpl(C, 'Partial operator', r'\frac{\partial}{\partial #{1}}')
tpl(C, 'Second partial', r'\frac{\partial^{2} #{1}}{\partial #{2}^{2}}'); tpl(C, 'Mixed partial', r'\frac{\partial^{2} #{1}}{\partial #{2}\,\partial #{3}}')
tpl(C, 'Partial subscript', r'\partial_{#{1}}'); tpl(C, 'Functional derivative', r'\frac{\delta #{1}}{\delta #{2}}')
tpl(C, 'Prime', r"#{1}'"); tpl(C, 'Time derivative (dot)', r'\dot{#{1}}'); tpl(C, 'Second time derivative', r'\ddot{#{1}}')
tpl(C, 'Gradient', r'\nabla #{1}'); tpl(C, 'Divergence', r'\nabla\cdot #{1}'); tpl(C, 'Curl', r'\nabla\times #{1}'); tpl(C, 'Laplacian', r'\nabla^{2} #{1}')
tpl(C, 'Differential', r'\mathrm{d}#{1}'); tpl(C, 'Evaluated at', r'\left. #{1} \right|_{#{2}}')
tpl(C, 'Integral', r'\int #{1}\,\mathrm{d}#{2}'); tpl(C, 'Definite integral', r'\int_{#{1}}^{#{2}} #{3}\,\mathrm{d}#{4}')
tpl(C, 'Double integral', r'\iint_{#{1}} #{2}\,\mathrm{d}#{3}', pkg='amsmath'); tpl(C, 'Triple integral', r'\iiint_{#{1}} #{2}\,\mathrm{d}#{3}', pkg='amsmath')
tpl(C, 'Contour integral', r'\oint_{#{1}} #{2}\,\mathrm{d}#{3}')
tpl(C, 'Sum', r'\sum_{#{1}}^{#{2}} #{3}'); tpl(C, 'Sum over set', r'\sum_{#{1}} #{2}'); tpl(C, 'Product', r'\prod_{#{1}}^{#{2}} #{3}')
tpl(C, 'Limit', r'\lim_{#{1}\to #{2}} #{3}')

V = 'Vectors & accents'
for nm, cmd in [('Vector', 'vec'), ('Hat', 'hat'), ('Bar', 'bar'), ('Tilde', 'tilde'), ('Wide hat', 'widehat'), ('Wide tilde', 'widetilde'), ('Overline', 'overline'), ('Underline', 'underline'), ('Overrightarrow', 'overrightarrow'), ('Bold symbol', 'boldsymbol'), ('Bold (upright)', 'mathbf')]:
    tpl(V, nm, '\\%s{#{1}}' % cmd, pkg='amsmath' if cmd == 'boldsymbol' else '')
tpl(V, 'Unit vector', r'\hat{\mathbf{#{1}}}'); tpl(V, 'Dot product', r'#{1}\cdot #{2}'); tpl(V, 'Cross product', r'#{1}\times #{2}')
tpl(V, 'Dagger (adjoint)', r'#{1}^{\dagger}'); tpl(V, 'Transpose', r'#{1}^{\mathsf{T}}'); tpl(V, 'Inverse', r'#{1}^{-1}'); tpl(V, 'Complex conjugate', r'#{1}^{*}')
tpl(V, 'Vector norm', r'\left\lVert #{1} \right\rVert', pkg='amsmath')
tpl(V, 'Overbrace', r'\overbrace{#{1}}^{#{2}}'); tpl(V, 'Underbrace', r'\underbrace{#{1}}_{#{2}}')
tpl(V, 'Overset', r'\overset{#{1}}{#{2}}', pkg='amsmath'); tpl(V, 'Extensible arrow', r'\xrightarrow[#{2}]{#{1}}', pkg='amsmath'); tpl(V, 'Cancel', r'\cancel{#{1}}', pkg='cancel')

M = 'Matrices'
tpl(M, 'Matrix 2×2 ( )', mat('pmatrix', 2, 2), pkg='amsmath'); tpl(M, 'Matrix 3×3 ( )', mat('pmatrix', 3, 3), pkg='amsmath')
tpl(M, 'Matrix 2×2 [ ]', mat('bmatrix', 2, 2), pkg='amsmath'); tpl(M, 'Determinant 2×2', mat('vmatrix', 2, 2), pkg='amsmath')
tpl(M, 'Column vector (2)', mat('pmatrix', 2, 1), pkg='amsmath'); tpl(M, 'Column vector (3)', mat('pmatrix', 3, 1), pkg='amsmath'); tpl(M, 'Row vector (3)', mat('pmatrix', 1, 3), pkg='amsmath')

Q = 'Quantum & physics'
tpl(Q, 'Bra', r'\langle #{1} |'); tpl(Q, 'Ket', r'| #{1} \rangle'); tpl(Q, 'Braket', r'\langle #{1} | #{2} \rangle'); tpl(Q, 'Expectation value', r'\langle #{1} \rangle')
tpl(Q, 'Matrix element', r'\langle #{1} | #{2} | #{3} \rangle'); tpl(Q, 'Outer product', r'| #{1} \rangle\langle #{2} |')
tpl(Q, 'Commutator', r'\left[ #{1}, #{2} \right]'); tpl(Q, 'Anticommutator', r'\left\{ #{1}, #{2} \right\}'); tpl(Q, 'Trace', r'\mathrm{Tr}\left( #{1} \right)')
tpl(Q, 'Feynman slash', r'\not #{1}'); tpl(Q, 'Unit', r'\,\mathrm{#{1}}'); tpl(Q, 'Scientific notation', r'#{1}\times 10^{#{2}}')
tpl(Q, 'Four-vector component', r'#{1}^{#{2}}_{\phantom{#{2}}#{3}}')

F = 'Fonts'
for nm, cmd, pk in [('Text', 'text', 'amsmath'), ('Roman', 'mathrm', ''), ('Blackboard bold', 'mathbb', 'amssymb'), ('Calligraphic', 'mathcal', ''), ('Fraktur', 'mathfrak', 'amssymb'), ('Script', 'mathscr', 'mathrsfs'), ('Sans-serif', 'mathsf', ''), ('Typewriter', 'mathtt', ''), ('Operator name', 'operatorname', 'amsmath')]:
    tpl(F, nm, '\\%s{#{1}}' % cmd, pkg=pk)

E = 'Environments & text'
tpl(E, 'equation', '\\begin{equation}\n\t#{1}\n\\end{equation}', 'block'); tpl(E, 'equation*', '\\begin{equation*}\n\t#{1}\n\\end{equation*}', 'block', 'amsmath')
tpl(E, 'align', '\\begin{align}\n\t#{1} &= #{2} \\\\\n\t#{3} &= #{4}\n\\end{align}', 'block', 'amsmath'); tpl(E, 'align*', '\\begin{align*}\n\t#{1} &= #{2}\n\\end{align*}', 'block', 'amsmath')
tpl(E, 'gather', '\\begin{gather}\n\t#{1}\n\\end{gather}', 'block', 'amsmath'); tpl(E, 'Inline math $ $', '$#{1}$', 'block')
tpl(E, 'itemize', '\\begin{itemize}\n\t\\item #{1}\n\\end{itemize}', 'block'); tpl(E, 'enumerate', '\\begin{enumerate}\n\t\\item #{1}\n\\end{enumerate}', 'block')
tpl(E, 'figure', '\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{#{1}}\n\t\\caption{#{2}}\n\t\\label{fig:#{3}}\n\\end{figure}', 'block', 'graphicx')
tpl(E, 'table', '\\begin{table}[htbp]\n\t\\centering\n\t\\begin{tabular}{#{1}}\n\t\t\\hline\n\t\t#{2} \\\\\n\t\t\\hline\n\t\\end{tabular}\n\t\\caption{#{3}}\n\t\\label{tab:#{4}}\n\\end{table}', 'block')
tpl(E, 'theorem', '\\begin{theorem}\n\t#{1}\n\\end{theorem}', 'block', 'amsthm'); tpl(E, 'proof', '\\begin{proof}\n\t#{1}\n\\end{proof}', 'block', 'amsthm'); tpl(E, 'abstract', '\\begin{abstract}\n\t#{1}\n\\end{abstract}', 'block')
for nm, ins in [('\\section', '\\section{#{1}}'), ('\\subsection', '\\subsection{#{1}}'), ('\\label', '\\label{#{1}}'), ('\\ref', '\\ref{#{1}}'), ('\\eqref', '\\eqref{#{1}}'), ('\\cite', '\\cite{#{1}}'), ('\\footnote', '\\footnote{#{1}}'),
                ('\\textbf', '\\textbf{#{1}}'), ('\\textit', '\\textit{#{1}}'), ('\\emph', '\\emph{#{1}}'), ('\\texttt', '\\texttt{#{1}}'), ('\\underline', '\\underline{#{1}}'),
                ('\\href', '\\href{#{1}}{#{2}}'), ('\\input', '\\input{#{1}}'), ('\\includegraphics', '\\includegraphics[width=0.8\\linewidth]{#{1}}')]:
    tpl(E, nm, ins, 'block', 'hyperref' if 'href' in nm else '')
for t in TPL:
    t['n'] = t['n']
    if t['m'] == 'math':
        t['r'] = ' '.join(re.sub(r'#\{\d+\}', r'\\square ', t['i'].replace('\\\\', '\\\\ ')).split()).replace(r'\text{\square }', r'\text{$\square$}').replace(r'\text{\square}', r'\text{$\square$}')

# ---- typesetting helper ---------------------------------------------------------------------------------------
HEAD = r"""\documentclass[10pt]{article}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb,amsfonts,mathtools,latexsym,mathrsfs,textcomp,cancel}
\usepackage[active,tightpage]{preview}
\setlength\PreviewBorder{3pt}
\newenvironment{symb}{}{}
\PreviewEnvironment{symb}
\begin{document}
"""
HEADER_LINES = HEAD.count('\n')

def typeset(items, tag):
    """items: [(snippet, mode)] -> list of ink arrays (or None when LaTeX failed)"""
    work = tempfile.mkdtemp(prefix='symgen')
    body = []
    for snippet, mode in items:
        snippet = snippet.replace('‸', '')
        body.append((r'\begin{symb}$\displaystyle ' + snippet + r'$\end{symb}') if mode == 'math' else (r'\begin{symb}' + snippet + r'\end{symb}'))
    open(os.path.join(work, 'sym.tex'), 'w').write(HEAD + '\n'.join(body) + '\n\\end{document}\n')
    subprocess.run(['pdflatex', '-interaction=nonstopmode', '-file-line-error', '-no-shell-escape', 'sym.tex'], cwd=work, capture_output=True, text=True)
    log = open(os.path.join(work, 'sym.log'), errors='ignore').read()
    bad = set()
    for m in re.finditer(r'sym\.tex:(\d+): (?:Undefined control sequence|LaTeX Error|Missing|Package \S+ Error)', log):
        bad.add(int(m.group(1)) - HEADER_LINES - 1)
    subprocess.run(['pdftoppm', '-r', str(DPI), '-gray', '-png', 'sym.pdf', 'p'], cwd=work, check=True)
    pngs = sorted(f for f in os.listdir(work) if f.startswith('p-') and f.endswith('.png'))
    if len(pngs) != len(items): sys.exit(f'[{tag}] page/item mismatch: {len(pngs)} vs {len(items)}')
    out = []
    for idx, fn in enumerate(pngs):
        if idx in bad: out.append(None); continue
        g = 1.0 - np.array(Image.open(os.path.join(work, fn)).convert('L')).astype(float) / 255.0
        ys, xs = np.where(g > 0.25)
        out.append(g[ys.min():ys.max() + 1, xs.min():xs.max() + 1] if len(xs) >= 4 else None)
    print(f'[{tag}] {len(items)} typeset, {sum(o is None for o in out)} failed', file=sys.stderr)
    shutil.rmtree(work)
    return out

# ---- skeleton features -----------------------------------------------------------------------------------------
def thin(img):
    img = img.astype(np.uint8).copy()
    changed = True
    while changed:
        changed = False
        for step in (0, 1):
            P = np.pad(img, 1)
            p2, p3, p4, p5 = P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:], P[2:, 2:]
            p6, p7, p8, p9 = P[2:, 1:-1], P[2:, :-2], P[1:-1, :-2], P[:-2, :-2]
            nb = [p2, p3, p4, p5, p6, p7, p8, p9]
            B_ = sum(n.astype(int) for n in nb)
            A_ = sum(((nb[k] == 0) & (nb[(k + 1) % 8] == 1)).astype(int) for k in range(8))
            if step == 0: c1 = (p2 * p4 * p6) == 0; c2 = (p4 * p6 * p8) == 0
            else: c1 = (p2 * p4 * p8) == 0; c2 = (p2 * p6 * p8) == 0
            m = (img == 1) & (B_ >= 2) & (B_ <= 6) & (A_ == 1) & c1 & c2
            if m.any(): img[m] = 0; changed = True
    return img

def erode(a):
    P = np.pad(a, 1)
    return a & P[:-2, 1:-1] & P[2:, 1:-1] & P[1:-1, :-2] & P[1:-1, 2:]

def points_for(ink):
    h, w = ink.shape
    L = 64.0 / max(h, w)
    nh, nw = max(1, round(h * L)), max(1, round(w * L))
    im = Image.fromarray((ink * 255).astype(np.uint8)).resize((nw, nh), Image.LANCZOS)
    b = np.pad(np.array(im) > 110, 2)
    sk = thin(b).astype(bool)
    area, skl = b.sum(), max(1, sk.sum())
    pts = np.argwhere(sk)
    if area / skl > 5.5: pts = np.vstack([pts, np.argwhere(b & ~erode(b))])  # filled blob: add outline
    ys, xs = pts[:, 0].astype(float), pts[:, 1].astype(float)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    span = max(xs.max() - xs.min(), ys.max() - ys.min(), 1.0)
    u = (xs - cx) / span + 0.5; v = (ys - cy) / span + 0.5
    cells = {}
    for a, c in zip(u, v):
        cells.setdefault((min(GRID - 1, int(a * GRID)), min(GRID - 1, int(c * GRID))), []).append((a, c))
    out = sorted([round(sum(p[0] for p in l) / len(l) * 100), round(sum(p[1] for p in l) / len(l) * 100)] for l in cells.values())
    return [n for p in out for n in p], (xs.max() - xs.min() + 1) / (ys.max() - ys.min() + 1)

def sprite(tiles, cols, cw, ch, path):
    rows = max(1, math.ceil(len(tiles) / cols))
    sheet = Image.new('RGBA', (cols * cw, rows * ch), (0, 0, 0, 0))
    for n, tile in enumerate(tiles):
        x = (n % cols) * cw + (cw - tile.width) // 2
        y = (n // cols) * ch + (ch - tile.height) // 2
        black = Image.new('RGBA', tile.size, (0, 0, 0, 255)); black.putalpha(tile)
        sheet.alpha_composite(black, (x, y))
    sheet.save(path, optimize=True)
    return sheet.size

def tile_of(ink, cw, ch):
    ih, iw = ink.shape
    s = min(1.0, (cw - 8) / iw, (ch - 8) / ih)
    return Image.fromarray((ink * 255).astype(np.uint8)).resize((max(1, round(iw * s)), max(1, round(ih * s))), Image.LANCZOS)

os.makedirs(OUT, exist_ok=True)

# flatten the symbol table
entries = []
for name, pkg, mode, items in T:
    for it_ in items:
        if isinstance(it_, tuple): label, render, ins = it_
        else:
            label = it_ if it_.startswith('\\') else '\\' + it_
            render = ins = label
        entries.append(dict(c=label, r=render, i=ins, cat=name, pkg=pkg, mode=mode))
seen = set(); uniq = []
for e in entries:
    k = (e['c'], e['mode'])
    if k in seen: continue
    seen.add(k); uniq.append(e)
entries = uniq

# symbols
inks = typeset([(e['r'], e['mode']) for e in entries], 'symbols')
syms, tiles, dropped = [], [], []
for e, ink in zip(entries, inks):
    if ink is None: dropped.append(e['c']); continue
    pts, aspect = points_for(ink)
    tiles.append(tile_of(ink, CELL_W, CELL_H))
    syms.append(dict(c=e['c'], i=e['i'], cat=e['cat'], pkg=e['pkg'], m=e['mode'], k=ALIASES.get(e['c'].lstrip('\\'), ''), a=round(aspect, 3), p=pts, t=len(tiles) - 1))
COLS = 24
sz = sprite(tiles, COLS, CELL_W, CELL_H, os.path.join(OUT, 'sprite.png'))

# templates (previews only; they are not part of the Detexify matcher)
TCW, TCH, TCOLS = 160, 96, 12
tinks = typeset([(t['r'], 'math') for t in TPL if t['m'] == 'math'], 'templates')
it = iter(tinks); ttiles = []; tplout = []
for t in TPL:
    tile = -1
    if t['m'] == 'math':
        ink = next(it)
        if ink is None: dropped.append('tpl:' + t['n']); continue
        ttiles.append(tile_of(ink, TCW, TCH)); tile = len(ttiles) - 1
    tplout.append(dict(n=t['n'], i=t['i'], cat=t['cat'], m=t['m'], pkg=t['pkg'], t=tile))
tsz = sprite(ttiles, TCOLS, TCW, TCH, os.path.join(OUT, 'templates.png'))

json.dump(dict(cols=COLS, cw=CELL_W, ch=CELL_H, symbols=syms, tcols=TCOLS, tcw=TCW, tch=TCH, templates=tplout), open(os.path.join(OUT, 'symbols.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
kb = lambda f: os.path.getsize(os.path.join(OUT, f)) // 1024
print(f'wrote {len(syms)} symbols + {len(tplout)} templates; sprite {sz}, templates {tsz}; json {kb("symbols.json")} KB, pngs {kb("sprite.png")}+{kb("templates.png")} KB', file=sys.stderr)
if dropped: print('dropped:', ' '.join(dropped), file=sys.stderr)
