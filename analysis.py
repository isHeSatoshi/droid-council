import json, os
def load(rid):
    d = os.path.join("runs", rid)
    ev=[]
    p=os.path.join(d,"events.jsonl")
    if os.path.exists(p):
        for line in open(p,encoding="utf-8"):
            line=line.strip()
            if line:
                try: ev.append(json.loads(line))
                except: pass
    rep={}
    rp=os.path.join(d,"report.json")
    if os.path.exists(rp):
        try: rep=json.load(open(rp,encoding="utf-8"))
        except: rep={}
    return ev,rep

for rid in ["cmp-single","team","team-fast"]:
    ev,rep = load(rid)
    spawn={e["id"]:e for e in ev if e.get("kind")=="spawn"}
    done={e["id"]:e for e in ev if e.get("kind")=="done"}
    end=next((e["at"] for e in reversed(ev) if e.get("kind")=="end"),0)
    workers=[i for i,s in spawn.items() if s.get("role")=="worker"]
    wdur=[done[i]["ms"] for i in workers if i in done]
    wstart=min([spawn[i]["at"] for i in workers], default=0)
    wend=max([spawn[i]["at"]+done[i]["ms"] for i in workers if i in done], default=0)
    wwall=wend-wstart
    tot=sum(wdur)
    print(f"--- {rid} ---")
    print(f"  droids={rep.get('droids')} wall={rep.get('seconds')}s credits={rep.get('credits')} failed={rep.get('failed')} conc={rep.get('concurrency')}")
    print(f"  workers={len(workers)} worker_sum={tot/1000:.0f}s worker_wall={wwall/1000:.0f}s speedup={tot/wwall if wwall else 0:.1f}x")
    print(f"  execute phase: {wstart/1000:.0f}s -> {wend/1000:.0f}s")
    print(f"  total wall: {end/1000:.0f}s")
