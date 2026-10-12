#!/usr/bin/env python3
"""Vérifications d'un projet Qt qmake qui ne compile que sous Windows (ActiveQt).

Le worker Linux ne peut pas compiler ce projet : ce contrôle attrape avant la PR
les erreurs les plus fréquentes d'une modification, la compilation complète
restant faite par le workflow Windows de GitHub Actions.
"""
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

LISTS = ("SOURCES", "HEADERS", "FORMS", "RESOURCES")


def read_pro(path):
    text = re.sub(r"\\\s*\n", " ", path.read_text(encoding="utf-8-sig"))
    values, version = {name: [] for name in LISTS}, None
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        match = re.match(r"^(\w+)\s*(\+|-)?=\s*(.*)$", line)
        if not match:
            continue
        name, operator, rest = match.groups()
        if name == "VERSION":
            version = rest.strip()
        elif name in LISTS and operator != "-":
            values[name] += [item.strip('"') for item in rest.split() if "$$" not in item]
    return values, version


def balanced(source):
    """Parenthèses, crochets et accolades équilibrés, hors commentaires et chaînes."""
    source = re.sub(r'R"([^(\s]{0,16})\((?:.|\n)*?\)\1"', '""', source)
    source = re.sub(r"//[^\n]*|/\*(?:.|\n)*?\*/", " ", source)
    source = re.sub(r'"(?:\\.|[^"\\\n])*"' + r"|'(?:\\.|[^'\\\n])*'", '""', source)
    pairs, stack = {")": "(", "]": "[", "}": "{"}, []
    for line_number, line in enumerate(source.split("\n"), 1):
        if line.lstrip().startswith("#"):
            continue  # Directives du préprocesseur.
        for char in line:
            if char in "([{":
                stack.append((char, line_number))
            elif char in pairs:
                if not stack or stack[-1][0] != pairs[char]:
                    return f"« {char} » inattendu ligne {line_number}"
                stack.pop()
    return f"« {stack[-1][0]} » non fermé (ouvert ligne {stack[-1][1]})" if stack else None


def check(root):
    errors, notes = [], []
    projects = sorted(root.glob("*.pro"))
    if len(projects) != 1:
        return [f"Un seul fichier .pro est attendu à la racine ({len(projects)} trouvé(s))."], notes
    values, version = read_pro(projects[0])
    notes.append(f"{projects[0].name} : {sum(len(v) for v in values.values())} fichiers déclarés")
    if version is None:
        notes.append("VERSION absente du .pro")
    elif not re.fullmatch(r"\d+\.\d+\.\d+", version):
        errors.append(f"VERSION « {version} » : format majeur.mineur.correctif attendu.")
    for name, files in values.items():
        for duplicate in sorted({f for f in files if files.count(f) > 1}):
            errors.append(f"{name} : « {duplicate} » est déclaré plusieurs fois.")
        for item in files:
            if not (root / item).is_file():
                errors.append(f"{name} : « {item} » est déclaré dans le .pro mais absent.")
    for item in values["FORMS"]:
        path = root / item
        if not path.is_file():
            continue
        try:
            ui = ET.parse(path).getroot()
        except ET.ParseError as error:
            errors.append(f"{item} : XML invalide ({error}).")
            continue
        widget = ui.find("widget")
        if ui.tag != "ui" or not ui.findtext("class") or widget is None or not widget.get("class") or not widget.get("name"):
            errors.append(f"{item} : formulaire Qt Designer incomplet (balises ui, class et widget principal).")
            continue
        names = [node.get("name") for node in ui.iter("widget") if node.get("name")]
        for duplicate in sorted({n for n in names if names.count(n) > 1}):
            errors.append(f"{item} : plusieurs widgets s'appellent « {duplicate} ».")
    for item in values["SOURCES"] + values["HEADERS"]:
        path = root / item
        if not path.is_file():
            continue
        problem = balanced(path.read_text(encoding="utf-8", errors="replace"))
        if problem:
            errors.append(f"{item} : {problem}.")
    headers = set(values["HEADERS"])
    for item in values["SOURCES"]:
        header = Path(item).with_suffix(".h").as_posix()
        if (root / header).is_file() and header not in headers and "Q_OBJECT" in (root / header).read_text(encoding="utf-8", errors="replace"):
            errors.append(f"{header} : classe Q_OBJECT absente de HEADERS (moc ne la traiterait pas).")
    return errors, notes


def main():
    errors, notes = check(Path.cwd())
    for line in notes:
        print(line)
    for line in errors:
        print("Erreur : " + line)
    if errors:
        print(f"{len(errors)} erreur(s). La compilation Windows complète est faite par GitHub Actions.")
        return 1
    print("Projet Qt cohérent. La compilation Windows complète est faite par GitHub Actions.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
