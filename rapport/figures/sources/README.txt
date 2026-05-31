=========================================================================
SOURCES DES DIAGRAMMES - Mode d'emploi
=========================================================================

Tous les diagrammes du rapport sont generes depuis des sources externes
(Mermaid ou PlantUML) puis inseres dans LaTeX comme images PNG.

-------------------------------------------------------------------------
DIAGRAMMES GENERAUX (chapitre 2)
-------------------------------------------------------------------------
gantt.mmd                 -> mermaid.live          -> figures/gantt.png
nova-archi.mmd            -> mermaid.live          -> figures/nova-archi.png
archi-illustr.puml        -> plantuml.com          -> figures/archi-illustr.png
uc.puml                   -> plantuml.com          -> figures/uc.png
class-global.puml         -> plantuml.com          -> figures/class-global.png

-------------------------------------------------------------------------
DIAGRAMMES DE SEQUENCE -- Sprint 1 (chapitre 3)
-------------------------------------------------------------------------
seq-s1-login-admin.puml    -> plantuml.com -> figures/seq-s1-login-admin.png
seq-s1-login-patient.puml  -> plantuml.com -> figures/seq-s1-login-patient.png
seq-s1-chat-whatsapp.puml  -> plantuml.com -> figures/seq-s1-chat-whatsapp.png
seq-s1-rappels.puml        -> plantuml.com -> figures/seq-s1-rappels.png

-------------------------------------------------------------------------
DIAGRAMMES DE SEQUENCE -- Sprint 2 (chapitre 4)
-------------------------------------------------------------------------
seq-s2-rdv.puml            -> plantuml.com -> figures/seq-s2-rdv.png
seq-s2-dossier.puml        -> plantuml.com -> figures/seq-s2-dossier.png
seq-s2-doc-ocr.puml        -> plantuml.com -> figures/seq-s2-doc-ocr.png

-------------------------------------------------------------------------
DIAGRAMMES DE SEQUENCE -- Sprint 3 (chapitre 5)
-------------------------------------------------------------------------
seq-s3-demand-fill.puml    -> plantuml.com -> figures/seq-s3-demand-fill.png
seq-s3-voucher.puml        -> plantuml.com -> figures/seq-s3-voucher.png
seq-s3-queue.puml          -> plantuml.com -> figures/seq-s3-queue.png

=========================================================================
PROCEDURE (identique pour tous)
=========================================================================

1. Ouvre le fichier source dans un editeur de texte (Bloc-notes, VS Code).
2. Selectionne TOUT le contenu (Ctrl+A) et copie (Ctrl+C).
3. Va sur le site correspondant :
   - https://mermaid.live           pour les .mmd
   - https://www.plantuml.com/      pour les .puml
     plantuml/uml
4. Colle (Ctrl+V) dans l'editeur en ligne. Le diagramme apparait a droite.
5. Telecharge en PNG :
   - Mermaid Live : "Actions" -> "PNG" (decoche "background" pour transparent)
   - PlantUML : clic droit sur l'image -> "Enregistrer l'image sous..."
6. Renomme le fichier selon la colonne cible ci-dessus et depose-le
   dans figures/ (ecrase l'ancien si besoin).
7. Recompile sur Overleaf : la nouvelle image apparait.

=========================================================================
NOTES
=========================================================================

* Les sources commencent directement par le mot-cle (gantt, flowchart,
  @startuml) : ne pas ajouter de commentaires avant la declaration.

* Tant qu'un PNG n'existe pas dans figures/, un cadre placeholder
  apparait a sa place. La compilation LaTeX ne casse jamais.

* Pour modifier couleurs/disposition, edite directement le fichier
  source et regenere le PNG.

* Diagrammes de sequence : chaque cas d'utilisation a son propre
  diagramme. La liste correspond aux cas d'utilisation raffines
  retenus pour chaque sprint.
