# Rapport de PFE Nova AI — Source LaTeX (modele ISIMK)

Source LaTeX du rapport de Projet de Fin d'Etudes Nova~AI, structuree
selon le modele ISIM Kairouan / Universite de Kairouan, prete pour Overleaf.

## Comment utiliser dans Overleaf

1. Compresser ce dossier en un fichier `.zip` (Overleaf importe les zip).
2. Sur Overleaf : **New Project → Upload Project**, deposer le zip.
3. Le fichier principal `main.tex` est detecte automatiquement.
4. Compilateur : **pdfLaTeX** (defaut). Compile proprement avec
   `pdflatex` → `bibtex` → `pdflatex` → `pdflatex`.

## Format conforme au modele PFE standard

- Times New Roman 12 pt (via `newtxtext`)
- Interligne 1,5
- Marges : 2,5 cm haut/bas, 3 cm gauche, 2,5 cm droite
- Numerotation arabe des chapitres (Chapitre 1, 2, 3...)
- Numerotation hierarchique : 1.1, 1.1.1, 1.1.1.1
- Style de titre de chapitre : "Chapitre X" sur la premiere ligne puis
  le titre du chapitre en dessous (style report.cls standard)
- Entete : titre du chapitre courant a gauche, numero de page a droite
- Page de garde avec composition du jury
- Sections d'usage : Dedicaces, Remerciements, Table des matieres,
  Listes des figures/tableaux/abreviations, Introduction generale,
  Chapitres, Conclusion generale, Bibliographie

## Structure des fichiers

```
rapport/
├── main.tex                           ← point d'entree
├── references.bib                     ← bibliographie BibTeX
├── README.md                          ← ce fichier
├── front/
│   ├── page-de-garde.tex              ← page de garde ISIMK
│   ├── dedicaces.tex
│   ├── remerciements.tex
│   └── abreviations.tex
├── chapters/
│   ├── intro-generale.tex
│   ├── chap1-cadre.tex                ← Cadre general (organisme + contexte + problematique)
│   ├── methodologie.tex               ← Methodologie Scrum (incluse dans chap1)
│   ├── chap2-analyse.tex              ← Sprint 0 : analyse et specification
│   ├── chap3-sprint1.tex              ← Sprint 1 : fondations
│   ├── chap4-sprint2.tex              ← Sprint 2 : surfaces operationnelles
│   ├── chap5-sprint3.tex              ← Sprint 3 : couche d'intelligence
│   └── conclusion.tex
└── figures/
    └── (deposer ici les captures d'ecran et diagrammes)
```

## Ce qui est deja redige

- Page de garde ISIMK avec composition du jury (pre-remplie au nom de
  Mehdi Cheikh, ISIMK, Licence Sciences Informatiques specialite
  Informatique et Multimedia, 2025-2026).
- Dedicaces et remerciements (placeholders pour noms d'encadrants).
- Liste des abreviations (27 entrees usuelles).
- Introduction generale complete.
- Chapitre I (Cadre general) : organisme, contexte tunisien des PME,
  etude de l'existant, problematique, solution proposee, methodologie
  Scrum complete (Roles, Evenements, Artefacts, Justification).
- Chapitre II (Sprint 0) : 4 acteurs, 38 besoins fonctionnels en tableau,
  9 besoins non fonctionnels, environnement technique en deux tableaux,
  diagrammes placeholders, planification.
- Chapitre III (Sprint 1) : schema, RLS, auth, webhook, classifieur IA.
- Chapitre IV (Sprint 2) : tableau de bord, calendrier, pipeline labo,
  OCR, PWA.
- Chapitre V (Sprint 3) : 8 fonctionnalites d'intelligence detaillees.
- Conclusion : bilan, lecons, limites, perspectives, reflexion.
- `references.bib` avec entrees Claude, Supabase, WhatsApp, Whisper,
  Scrum guide, ElevenLabs, Vercel.

## A completer

Chercher les `[...]` dans les fichiers `.tex` :
- `[Nom de l'encadrant universitaire]` dans `front/remerciements.tex`
- `[Nom de l'organisme d'accueil]`, etc. dans `chap1-cadre.tex`
- Composition du jury dans `front/page-de-garde.tex`

Et inserer les figures reelles dans `figures/` :
- Logo ISIMK (`logo-isimk.png`)
- Organigramme de l'organisme
- Cycle de vie Scrum (`scrum-cycle.png`)
- Architecture globale Nova AI
- Diagramme de cas d'utilisation
- Modele entites-relations
- Diagramme de sequence prise de rendez-vous
- Captures d'ecran : tableau de bord, calendrier, pipeline labo, PWA, etc.

## Compilation locale

```bash
pdflatex main.tex
bibtex   main
pdflatex main.tex
pdflatex main.tex
```

Distribution TeX requise : MiKTeX (Windows), MacTeX (macOS), TeX Live (Linux).

— Realise pour **MEHDI CHEIKH**, ISIM Kairouan, 2025--2026.
