import {describe,it,expect} from "vitest";
import type {Agent} from "../../api/skills";
import {selectMainAgent} from "./main-agent";
import {layoutPositionChanges} from "./canvas-layout-patch";

describe("single main agent",()=>{
 it("prefers the production orchestrator despite duplicates and ordering",()=>{
  const rows=[{id:"a",name:"生产Agent",enabled:true},{id:"b",deploy_key:"productionAgent",enabled:true},{id:"c",parent_deploy_key:"productionAgent",enabled:true}] as Agent[];
  expect(selectMainAgent(rows)?.id).toBe("b");
  expect(selectMainAgent([...rows].reverse())?.id).toBe("b");
 });
 it("never chooses disabled agents or specialists",()=>{
  expect(selectMainAgent([{id:"a",enabled:false,deploy_key:"productionAgent"},{id:"b",enabled:true,parent_deploy_key:"root"}] as Agent[])).toBeNull();
 });
});
describe("atomic layout patch",()=>{
 const nodes=[{id:"a",position:{x:0,y:0},data:{}},{id:"b",position:{x:0,y:0},data:{}}];
 const patch={op:"move_nodes" as const,moves:[{node_id:"a",position:{x:100,y:100},from_position:{x:0,y:0}},{node_id:"b",position:{x:440,y:100},from_position:{x:0,y:0}}]};
 it("creates one batch of position changes",()=>{expect(layoutPositionChanges(nodes,patch)).toHaveLength(2);expect(nodes[0].position.x).toBe(0)});
 it("rejects the whole layout after a manual move",()=>{expect(()=>layoutPositionChanges([nodes[0],{...nodes[1],position:{x:10,y:0}}],patch)).toThrow("手动移动")});
 it("rejects deleted, locked and duplicate nodes",()=>{
  expect(()=>layoutPositionChanges([nodes[0]],patch)).toThrow();
  expect(()=>layoutPositionChanges([{...nodes[0],draggable:false},nodes[1]],patch)).toThrow("锁定");
  expect(()=>layoutPositionChanges(nodes,{...patch,moves:[patch.moves[0],patch.moves[0]]})).toThrow();
 });
});
