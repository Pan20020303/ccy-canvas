import type { Node, NodePositionChange } from "@xyflow/react";
import type { CanvasPatch } from "../../api/agent-run";

/** Validate the whole layout before applying anything; manual edits win. */
export function layoutPositionChanges(nodes: Node[], patch: Extract<CanvasPatch, {op:"move_nodes"}>): NodePositionChange[] {
  if (!patch.moves.length || patch.moves.length > 200) throw new Error("布局节点数量无效");
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const seen=new Set<string>();
  return patch.moves.map(move=>{
    const node=byId.get(move.node_id);
    if (!node || seen.has(move.node_id)) throw new Error("布局目标已变化，请重新整理");
    seen.add(move.node_id);
    if (node.draggable===false || node.data.locked===true) throw new Error("布局中包含锁定节点");
    if (![move.position?.x,move.position?.y,move.from_position?.x,move.from_position?.y].every(Number.isFinite)) throw new Error("布局坐标无效");
    if (Math.abs(node.position.x-move.from_position.x)>0.5 || Math.abs(node.position.y-move.from_position.y)>0.5) throw new Error("节点已被手动移动，本次布局未覆盖你的修改");
    return {id:move.node_id,type:"position",position:move.position,dragging:false};
  });
}
