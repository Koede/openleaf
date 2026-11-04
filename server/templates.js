// Starter projects. BibTeX (not biblatex/biber) so they compile on a bare TeX Live.
const article = {
  'main.tex': String.raw`\documentclass[11pt]{article}
\input{preamble}

\title{My Multi-File LaTeX Project}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle
\begin{abstract}
This project is split over several files. Edit any of them and the preview recompiles automatically.
\end{abstract}

\input{chapters/01-introduction}
\input{chapters/02-methods}

\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`,
  'preamble.tex': String.raw`\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{tikz}
\usepackage[margin=1in]{geometry}
\usepackage{hyperref}
\graphicspath{{figures/}}
`,
  'chapters/01-introduction.tex': String.raw`\section{Introduction}
This section lives in \texttt{chapters/01-introduction.tex} and is pulled in with \verb|\input|.
Quantum chromodynamics is described by the Lagrangian~\cite{peskin}
\begin{equation}
  \mathcal{L}_{\mathrm{QCD}} = \bar\psi\,(i\gamma^\mu D_\mu - m)\,\psi - \tfrac{1}{4}\,G^a_{\mu\nu}G^{a\,\mu\nu}.
  \label{eq:qcd}
\end{equation}
`,
  'chapters/02-methods.tex': String.raw`\section{Methods}
Equation~\ref{eq:qcd} is revisited here. Figure~\ref{fig:tikz} is defined in \texttt{figures/diagram.tex}.
\begin{figure}[h]
  \centering
  \input{figures/diagram}
  \caption{A figure included from a separate file.}
  \label{fig:tikz}
\end{figure}
`,
  'figures/diagram.tex': String.raw`\begin{tikzpicture}[scale=1.2]
  \draw[->] (0,0) -- (3,0) node[right] {$x$};
  \draw[->] (0,0) -- (0,2) node[above] {$y$};
  \draw[thick,blue,domain=0:3] plot (\x,{0.2*\x*\x});
\end{tikzpicture}
`,
  'refs.bib': String.raw`@book{peskin,
  author    = {Peskin, Michael E. and Schroeder, Daniel V.},
  title     = {An Introduction to Quantum Field Theory},
  publisher = {Westview Press},
  year      = {1995}
}
`,
};

const report = {
  'main.tex': String.raw`\documentclass[11pt,a4paper]{report}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb,graphicx,hyperref}
\title{Report Title}
\author{Your Name}
\begin{document}
\maketitle
\tableofcontents
\include{chapters/introduction}
\include{chapters/results}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`,
  'chapters/introduction.tex': String.raw`\chapter{Introduction}
Write your introduction here.
`,
  'chapters/results.tex': String.raw`\chapter{Results}
\section{First result}
Text with a citation~\cite{knuth}.
`,
  'refs.bib': String.raw`@book{knuth,
  author = {Donald E. Knuth},
  title = {The {\TeX}book},
  publisher = {Addison-Wesley},
  year = {1984}
}
`,
};

const beamer = {
  'main.tex': String.raw`\documentclass{beamer}
\usetheme{Madrid}
\title{Presentation Title}
\author{Your Name}
\date{\today}
\begin{document}
\frame{\titlepage}
\input{slides/outline}
\input{slides/content}
\end{document}
`,
  'slides/outline.tex': String.raw`\begin{frame}{Outline}
  \tableofcontents
\end{frame}
`,
  'slides/content.tex': String.raw`\section{Motivation}
\begin{frame}{A first slide}
  \begin{itemize}
    \item One point
    \item Another point with math: $E = mc^2$
  \end{itemize}
\end{frame}
`,
};

const letter = {
  'main.tex': String.raw`\documentclass[11pt]{letter}
\usepackage[utf8]{inputenc}
\signature{Your Name}
\address{Your Address \\ City}
\begin{document}
\begin{letter}{Recipient \\ Address}
\opening{Dear Sir or Madam,}
Write your letter here.
\closing{Sincerely,}
\end{letter}
\end{document}
`,
};

const blank = { 'main.tex': '\\documentclass{article}\n\\begin{document}\nHello, world!\n\\end{document}\n' };

module.exports = {
  list: [
    { id: 'article', name: 'Article (multi-file)', description: 'Preamble, chapters, figure, bibliography', files: article },
    { id: 'report', name: 'Report', description: 'Chapters with \\include and a bibliography', files: report },
    { id: 'beamer', name: 'Slides (beamer)', description: 'Presentation split into slide files', files: beamer },
    { id: 'letter', name: 'Letter', description: 'Simple letter', files: letter },
    { id: 'blank', name: 'Blank', description: 'Just a main.tex', files: blank },
  ],
};
