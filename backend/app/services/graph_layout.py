"""Presentation hierarchy derived from real note relationships and tag groups."""

from collections import Counter, deque


def enrich_graph(nodes, edges, truncated=False):
    neighbors = {node["id"]: set() for node in nodes}
    for edge in edges:
        neighbors[edge["source"]].add(edge["target"])
        neighbors[edge["target"]].add(edge["source"])
    tag_counts = Counter(tag["id"] for node in nodes for tag in node["tags"])
    groups = {}
    for node in nodes:
        tags = sorted(node["tags"], key=lambda tag: (tag_counts[tag["id"]], tag["id"]))
        if tags:
            region_id, label = "tag:" + tags[0]["id"], tags[0]["name"]
        else:
            label = node["folder"].split("/")[0] or "未分类"
            region_id = "folder:" + label
        node["region_id"] = region_id
        node["weight"] = 1 + len(neighbors[node["id"]])
        groups.setdefault(region_id, dict(id=region_id, label=label, nodes=[]))["nodes"].append(
            node
        )
    regions = []
    for group in groups.values():
        members = {node["id"] for node in group["nodes"]}
        root = min(group["nodes"], key=lambda node: (-node["weight"], node["id"]))
        visited = {root["id"]: (None, 0)}
        queue = deque([root["id"]])
        while queue:
            identifier = queue.popleft()
            for target in sorted(neighbors[identifier] & members):
                if target not in visited:
                    visited[target] = (identifier, visited[identifier][1] + 1)
                    queue.append(target)
        for node in group["nodes"]:
            # Unconnected documents share a visual region, not an invented
            # factual edge. Null parent keeps that distinction explicit.
            parent, depth = visited.get(node["id"], (None, 1))
            node.update(
                parent_id=parent,
                depth=depth,
                kind="star" if node is root else "moon" if depth >= 2 else "planet",
            )
        regions.append(
            dict(id=group["id"], label=group["label"], root_id=root["id"], node_ids=sorted(members))
        )
    return dict(nodes=nodes, edges=edges, regions=regions, truncated=truncated)
