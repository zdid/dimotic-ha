#!/usr/bin/env python3
"""Compare deux configurations ESPHome développées (`esphome config`) : listes à `id` comparées sans tenir compte de l'ordre
(sauf les pages LVGL), préambule et codes couleur ignorés. Usage : comparer-config.py <réf.yaml> <autre.yaml>"""
import yaml, json, re, sys
class L(yaml.SafeLoader): pass
def any_tag(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode): return {"!"+suffix: loader.construct_scalar(node)}
    if isinstance(node, yaml.SequenceNode): return {"!"+suffix: loader.construct_sequence(node, deep=True)}
    return {"!"+suffix: loader.construct_mapping(node, deep=True)}
L.add_multi_constructor("!", any_tag)
def load(f):
    t=open(f).read(); t=re.sub(r"\\033\[\d+m|\x1b\[\d+m","",t); t=t[t.index("esphome:"):]
    return yaml.load(t,Loader=L)
a,b=load(sys.argv[1]),load(sys.argv[2])
def norm(x):
    if isinstance(x, dict): return {k: norm(v) for k, v in x.items()}
    if isinstance(x, list):
        n=[norm(v) for v in x]
        if n and all(isinstance(v, dict) and "id" in v for v in n) and not any(str(v.get("id","")).startswith("page_") for v in n):
            n=sorted(n, key=lambda v: json.dumps(v.get("id"), default=str))
        return n
    return x
na,nb=norm(a),norm(b)
diffs=[]
def cmp(x,y,path):
    if type(x)!=type(y): diffs.append((path,"type",str(x)[:80],str(y)[:80])); return
    if isinstance(x,dict):
        for k in set(x)|set(y):
            if k not in x or k not in y: diffs.append((path+"/"+str(k),"absent", k in x, k in y))
            else: cmp(x[k],y[k],path+"/"+str(k))
    elif isinstance(x,list):
        if len(x)!=len(y): diffs.append((path,"longueur",len(x),len(y)))
        for i,(u,v) in enumerate(zip(x,y)): cmp(u,v,f"{path}[{i}]")
    elif x!=y: diffs.append((path,"valeur",str(x)[:80],str(y)[:80]))
cmp(na,nb,"")
print(len(diffs),"différence(s)"); [print(d) for d in diffs[:25]]
sys.exit(1 if diffs else 0)
if "lvgl" in nb:  # écrans seulement (un satellite vocal n'a pas de pages)
    lv=nb["lvgl"][0] if isinstance(nb["lvgl"],list) else nb["lvgl"]
    print("pages :", [p["id"] for p in lv["pages"]])
