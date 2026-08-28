import{a as i,d,j as e,L as l,p as n}from"./index-C_WurV6n.js";import{c as t}from"./createLucideIcon-Z3gY4WQR.js";import{S as p}from"./settings-BowLawW-.js";/**
 * @license lucide-react v1.30.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const x=[["ellipse",{cx:"12",cy:"5",rx:"9",ry:"3",key:"msslwz"}],["path",{d:"M3 5V19A9 3 0 0 0 21 19V5",key:"1wlel7"}],["path",{d:"M3 12A9 3 0 0 0 21 12",key:"mv7ke4"}]],y=t("database",x);/**
 * @license lucide-react v1.30.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const u=[["path",{d:"M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z",key:"1fr9dc"}],["path",{d:"M8 10v4",key:"tgpxqk"}],["path",{d:"M12 10v2",key:"hh53o1"}],["path",{d:"M16 10v6",key:"1d6xys"}]],b=t("folder-kanban",u);/**
 * @license lucide-react v1.30.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const m=[["rect",{width:"7",height:"9",x:"3",y:"3",rx:"1",key:"10lvy0"}],["rect",{width:"7",height:"5",x:"14",y:"3",rx:"1",key:"16une8"}],["rect",{width:"7",height:"9",x:"14",y:"12",rx:"1",key:"1hutg5"}],["rect",{width:"7",height:"5",x:"3",y:"16",rx:"1",key:"ldoo1y"}]],k=t("layout-dashboard",m);/**
 * @license lucide-react v1.30.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const g=[["path",{d:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",key:"1yyitq"}],["path",{d:"M16 3.128a4 4 0 0 1 0 7.744",key:"16gr8j"}],["path",{d:"M22 21v-2a4 4 0 0 0-3-3.87",key:"kshegd"}],["circle",{cx:"9",cy:"7",r:"4",key:"nufk8"}]],v=t("users",g);function M(){const{isAdmin:r}=i(),h=d(),s=[{path:"/admin/dashboard",label:"Dashboard",icon:k},{path:"/admin/questions",label:"Question Bank",icon:y},{path:"/admin/batches",label:"Batches",icon:b},{path:"/admin/settings",label:"AI Settings",icon:p}];return r&&s.push({path:"/admin/users",label:"Users",icon:v}),e.jsx("div",{className:"flex flex-wrap gap-2 mb-6 bg-slate-100/80 p-1.5 rounded-xl border border-slate-200/60 shadow-inner",children:s.map(a=>{const c=a.icon,o=h.pathname.startsWith(a.path);return e.jsxs(l,{to:a.path,onMouseEnter:()=>n(a.path),onFocus:()=>n(a.path),className:`
              flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-all
              ${o?"bg-white text-blue-700 shadow-sm ring-1 ring-slate-200/50":"text-slate-600 hover:text-slate-900 hover:bg-slate-200/50"}
            `,children:[e.jsx(c,{size:16,className:o?"text-blue-600":"text-slate-400"}),a.label]},a.path)})})}export{M as A,y as D,b as F,k as L,v as U};
