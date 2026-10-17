"""Build 奶蛙 from analytic surfaces, without input meshes or external Python packages.

    blender -b -P assets-src/naiwa/build_naiwa.py
    blender -b -P assets-src/naiwa/build_naiwa.py -- --renders

The first command exports the integration asset and validates its closed Body.
The second also renders the actual skinned model in reference and inspection poses.
Blender coordinates: X left, -Y forward, Z up; glTF converts to X, Y up, +Z forward.
"""
import bpy
import bmesh
import math
import json
import sys
import struct
import zlib
from pathlib import Path
from mathutils import Vector, Matrix, Quaternion
from mathutils.bvhtree import BVHTree

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / 'public/models/naiwa.glb'
RENDERS = HERE / 'renders'
STATES = ('Basis', 'laugh', 'tongue', 'surprise', 'blink')
PI = math.pi

def clamp(v, a=0., b=1.): return max(a, min(b, v))
def smooth(v):
    v = clamp(v)
    return v*v*(3-2*v)
def mix(a, b, t): return tuple(x*(1-t)+y*t for x,y in zip(a,b))
def linear(c): return c/12.92 if c <= .04045 else ((c+.055)/1.055)**2.4
def rgb(hexcode): return tuple(linear(int(hexcode[i:i+2],16)/255) for i in (0,2,4))
YELLOW = rgb('F3CB45')
CREAM = rgb('E7D094')
OLIVE = rgb('62552A')
DARK = rgb('2A1017')
LIP = rgb('705021')
WHITE = rgb('F5F1CE')
IRIS = rgb('87B65C')
PUPIL = rgb('101A0B')
PINK = rgb('E95869')

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for datablocks in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials):
    for datablock in list(datablocks):
        if datablock.users == 0: datablocks.remove(datablock)

def material(name, roughness=.5):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bs = m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Roughness'].default_value = roughness
    bs.inputs['Specular IOR Level'].default_value = .28
    col = m.node_tree.nodes.new('ShaderNodeVertexColor')
    col.layer_name = 'Color'
    m.node_tree.links.new(col.outputs['Color'], bs.inputs['Base Color'])
    return m

skinmat = material('Naiwa • warm yellow / cream / olive')
eyemat = material('Naiwa • green eyes', .34)
mouthmat = material('Naiwa • mouth and tongue', .43)

class Mesh:
    def __init__(self, name):
        self.name = name
        self.v = []; self.f = []; self.colors = []; self.weights = []; self.soft = []
        self.shapes = {k: [] for k in STATES}
    def vertex(self, p, color, weights, softness=.2, shapes=None):
        i = len(self.v); self.v.append(tuple(p)); self.colors.append(color)
        self.weights.append(weights); self.soft.append(softness)
        for k in STATES: self.shapes[k].append(tuple(shapes[k] if shapes else p))
        return i
    def face(self, *indices): self.f.append(tuple(indices))
    def split_long_edges(self, limit):
        """Add support in stretched throat/pole cells, preserving every morph."""
        def average(indices):
            count=len(indices)
            weights={}
            for i in indices:
                for name,value in self.weights[i].items(): weights[name]=weights.get(name,0)+value/count
            return self.vertex(sum((Vector(self.v[i]) for i in indices),Vector())/count,
                sum((Vector(self.colors[i]) for i in indices),Vector())/count,weights,
                sum(self.soft[i] for i in indices)/count,
                {state:sum((Vector(self.shapes[state][i]) for i in indices),Vector())/count for state in STATES})
        for _ in range(3):
            midpoints={}
            for face in self.f:
                for a,b in zip(face,face[1:]+face[:1]):
                    edge=tuple(sorted((a,b)))
                    if edge not in midpoints and (Vector(self.v[a])-Vector(self.v[b])).length>limit:
                        midpoints[edge]=average(edge)
            if not midpoints: break
            faces=[]
            for face in self.f:
                if not any(tuple(sorted((a,b))) in midpoints for a,b in zip(face,face[1:]+face[:1])):
                    faces.append(face);continue
                perimeter=[]
                for a,b in zip(face,face[1:]+face[:1]):
                    perimeter.append(a)
                    if tuple(sorted((a,b))) in midpoints: perimeter.append(midpoints[tuple(sorted((a,b)))])
                center=average(face)
                faces.extend((center,a,b) for a,b in zip(perimeter,perimeter[1:]+perimeter[:1]))
            self.f=faces
    def finish(self, mat):
        mesh = bpy.data.meshes.new(self.name)
        mesh.from_pydata(self.v, [], self.f); mesh.update()
        ob = bpy.data.objects.new(self.name, mesh)
        bpy.context.collection.objects.link(ob)
        mesh.materials.append(mat)
        col = mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='POINT')
        for i,c in enumerate(self.colors): col.data[i].color = (*c,1)
        if self.name == 'Body':
            a = mesh.attributes.new('_softness','FLOAT','POINT')
            for i,s in enumerate(self.soft): a.data[i].value = s
        for bn in sorted({n for w in self.weights for n in w}):
            vg = ob.vertex_groups.new(name=bn)
            for i,w in enumerate(self.weights):
                if w.get(bn,0)>0: vg.add([i], w[bn], 'REPLACE')
        # Consistent outward winding, without changing vertex order or shape indices.
        bm = bmesh.new(); bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(mesh); bm.free()
        for p in mesh.polygons: p.use_smooth = True
        for k in STATES:
            if k != 'Basis' and all(Vector(a)==Vector(b) for a,b in zip(self.shapes[k],self.v)): continue
            key = ob.shape_key_add(name=k, from_mix=False)
            key.value = 0.0
            for i,co in enumerate(self.shapes[k]): key.data[i].co = co
        return ob

def ellipsoid(mesh, center, scale, color, weights, segments=24, rings=12, transform=None):
    """Closed ellipsoid. transform can supply all expression positions and color."""
    ids=[]
    for j in range(rings+1):
        phi = PI*j/rings
        row=[]
        count=1 if j in (0,rings) else segments
        for i in range(count):
            theta=2*PI*i/segments
            q=Vector((math.sin(phi)*math.cos(theta), math.sin(phi)*math.sin(theta), math.cos(phi)))
            p=Vector(center)+Vector(tuple(q[k]*scale[k] for k in range(3)))
            shapes, c = (transform(p,q), color) if transform else (None,color)
            row.append(mesh.vertex(p,c,weights,shapes=shapes))
        ids.append(row)
    for j in range(rings):
        for i in range(segments):
            ni=(i+1)%segments
            if j==0: mesh.face(ids[j][0],ids[j+1][i],ids[j+1][ni])
            elif j==rings-1: mesh.face(ids[j][i],ids[j+1][0],ids[j][ni])
            else: mesh.face(ids[j][i],ids[j+1][i],ids[j+1][ni],ids[j][ni])

# z, half-width, half-depth, depth-centre. Small head, concave throat, low heavy belly.
PROFILE = [(.245,0,.0,.005),(.265,.100,.090,.005),(.300,.175,.155,.006),
           (.365,.230,.208,.008),(.445,.255,.232,.004),(.525,.246,.226,.006),
           (.605,.228,.198,.012),(.685,.200,.162,.012),(.755,.153,.128,.002),
           (.805,.127,.106,-.030),(.855,.116,.096,-.062),(.905,.111,.089,-.077),
           (.950,.096,.075,-.080),(.980,.064,.050,-.080),(1.,0,0,-.080)]

def profile(z):
    z=clamp(z,PROFILE[0][0],PROFILE[-1][0])
    k=next((i for i in range(len(PROFILE)-1) if PROFILE[i+1][0]>=z),len(PROFILE)-2)
    a,b=PROFILE[k],PROFILE[k+1]; t=(z-a[0])/(b[0]-a[0]); h=b[0]-a[0]
    out=[]
    for c in (1,2,3):
        prev=PROFILE[max(0,k-1)]; nxt=PROFILE[min(len(PROFILE)-1,k+2)]
        da=(b[c]-prev[c])/(b[0]-prev[0]); db=(nxt[c]-a[c])/(nxt[0]-a[0])
        out.append((2*t**3-3*t*t+1)*a[c]+(t**3-2*t*t+t)*h*da+(-2*t**3+3*t*t)*b[c]+(t**3-t*t)*h*db)
    if z > .905:
        dome=math.sqrt(max(0,1-((z-.905)/.095)**2))
        out[0]=.111*dome; out[1]=.089*dome
    return out

def front_y(x,z):
    rx,ry,cy=profile(z)
    return cy-ry*math.sqrt(max(.02,1-(x/max(.001,rx))**2))

def body_weights(z):
    anchors=[(.31,'hips'),(.51,'spine'),(.71,'chest'),(.82,'head')]
    if z<=anchors[0][0]: return {'hips':1.}
    if z>=anchors[-1][0]: return {'head':1.}
    for (a,an),(b,bn) in zip(anchors,anchors[1:]):
        if a<=z<=b:
            w=smooth((z-a)/(b-a)); return {an:1-w,bn:w}

MOUTH = {'Basis':(.063,.0025,.853),'blink':(.063,.0025,.853),
         'laugh':(.071,.073,.818),'tongue':(.070,.048,.838),'surprise':(.029,.031,.842)}
MC=.835; MH=.045; MW=.087
def lip_point(u,v,state):
    w,h,c=MOUTH[state]
    x=w*u; z=c+h*v+.009*u*u
    return Vector((x,front_y(x,z)-.003,z))

body=Mesh('Body')
N=80
zs=[.253,.263,.278,.295,.315,.338,.361,.385,.409,.433,.457,.481,.505,.529,.553,.577,.601,.625,.649,.673,.697,.721,.743,.761,.775,.790,.805,.820,.835,.850,.865,.880,.895,.910,.925,.940,.955,.967,.978,.987,.994,.998,.9995]
lo=zs.index(.790); hi=zs.index(.880); half=8; hole={}; ids={}
ring_counts={.253:24,.263:48,.278:64,.955:64,.967:56,.978:48,.987:32,.994:24,.998:16,.9995:8}
for iz,z in enumerate(zs):
    rx,ry,cy=profile(z)
    count=ring_counts.get(z,N)
    for j in range(-count//2,count//2):
        if lo<iz<hi and -half<j<half: continue
        theta=j*2*PI/count; x=rx*math.sin(theta); y=cy-ry*math.cos(theta)
        u=j/half; v=(z-MC)/MH; r=max(abs(u),abs(v)); radial=math.hypot(u,v)
        shapes={}
        if abs(j)<=16 and .72<z<.955 and r>=.999:
            eu=u/max(radial,.001); ev=v/max(radial,.001)
            influence=(1-smooth((r-1)/1.2))
            # Move the square boundary to an elliptical lip. Smoothly absorb displacement outside.
            base_boundary=Vector((profile(MC+v/r*MH)[0]*math.sin((u/r)*half*2*PI/N),0,MC+v/r*MH))
            for state in STATES:
                lp=lip_point(eu,ev,state)
                xx=x+(lp.x-base_boundary.x)*influence
                zz=z+(lp.z-base_boundary.z)*influence
                yy=front_y(xx,zz) if abs(theta)<1.25 else y
                yy=yy-.003*influence
                shapes[state]=(xx,yy,zz)
        else:
            shapes={s:(x,y,z) for s in STATES}
        p=shapes['Basis']
        # Patch is on the same continuous skin; smooth cream boundary follows a broad oval.
        patch=math.sqrt((x/.214)**2+((z-.545)/.170)**2)
        blend=(1-smooth((patch-.95)/.10))*smooth((math.cos(theta)-.25)/.28)
        color=mix(YELLOW,CREAM,blend)
        # Flesh stiffness changes gradually across the abdomen, independently
        # of the sharper painted cream edge. The back and face stay firm.
        softness=.2+.8*math.exp(-((x/.24)**4+((z-.53)/.24)**4))*smooth(math.cos(theta)/.65)
        idx=body.vertex(p,color,body_weights(p[2]),softness,shapes)
        ids[iz,j]=idx
        if (lo<=iz<=hi and abs(j)==half) or (iz in (lo,hi) and abs(j)<=half):
            hole[idx]=(math.atan2(v,u),u/r,v/r)
for iz in range(len(zs)-1):
    count=ring_counts.get(zs[iz],N); next_count=ring_counts.get(zs[iz+1],N)
    if count!=next_count:
        # Zipper unequal pole rings without giant fans or near-zero pole edges.
        a=[ids[iz,j] for j in range(-count//2,count//2)]
        b=[ids[iz+1,j] for j in range(-next_count//2,next_count//2)]
        i=j=0
        while i<count or j<next_count:
            ta=(i+1)/count;tb=(j+1)/next_count
            if abs(ta-tb)<1e-9:
                body.face(a[i%count],a[(i+1)%count],b[(j+1)%next_count],b[j%next_count]);i+=1;j+=1
            elif ta<tb:
                body.face(a[i%count],a[(i+1)%count],b[j%next_count]);i+=1
            else:
                body.face(a[i%count],b[(j+1)%next_count],b[j%next_count]);j+=1
        continue
    for j in range(-N//2,N//2):
        jj=(j+1+N//2)%N-N//2
        keys=[(iz,j),(iz,jj),(iz+1,jj),(iz+1,j)]
        if all(k in ids for k in keys):
            if lo<=iz<hi and -half<=j<half: continue
            body.face(*(ids[k] for k in keys))
for iz,z in [(0,.245),(len(zs)-1,1.)]:
    c=body.vertex((0,profile(z)[2],z),YELLOW,body_weights(z))
    count=ring_counts.get(zs[iz],N)
    for j in range(-count//2,count//2): body.face(c,ids[iz,j],ids[iz,(j+1+count//2)%count-count//2])

boundary=sorted(hole,key=lambda i:hole[i][0]); prev=boundary
for r,depth in [(.97,.001),(.92,.007),(.82,.026),(.60,.057),(.31,.077)]:
    row=[]
    for idx in boundary:
        angle=hole[idx][0]; u=math.cos(angle); v=math.sin(angle)
        shapes={}
        for state in STATES:
            lp=lip_point(r*u,r*v,state)
            # Pocket folds inwards, never removes the closed skin under the mouth.
            lp.y+=depth
            shapes[state]=lp
        color=mix(YELLOW,LIP,.35) if r>.95 else DARK
        row.append(body.vertex(shapes['Basis'],color,{'head':1},.15,shapes))
    for i in range(len(row)): body.face(prev[i],prev[(i+1)%len(row)],row[(i+1)%len(row)],row[i])
    prev=row
shapes={s:lip_point(0,0,s)+Vector((0,.083,0)) for s in STATES}
c=body.vertex(shapes['Basis'],DARK,{'head':1},.15,shapes)
for i in range(len(prev)): body.face(prev[i],prev[(i+1)%len(prev)],c)
body.split_long_edges(.032)
bodyob=body.finish(skinmat)

def paint_body():
    """An embedded analytic colour map gives the cream patch a clean organic edge.

    UV seams are on the back only; Blender's Body is still a single closed mesh.
    The app welds render-only glTF UV seam duplicates before constructing cells.
    """
    size=1024
    yellow=(243,203,69);cream=(231,208,148);dark=(42,16,23)
    raw=bytearray()
    angles=[(j/(size-1)-.5)*2*PI for j in range(size)]
    sins=[math.sin(a) for a in angles];coss=[math.cos(a) for a in angles]
    for row in range(size):
        raw.append(0)
        v=1-row/(size-1);z=.20+v*.85
        width=profile(z)[0]
        for j in range(size):
            if v<.018: color=dark
            elif v<.035: color=(184,145,50)
            else:
                x=width*sins[j]
                r=math.sqrt((x/.214)**2+((z-.545)/.170)**2)
                blend=(1-smooth((r-.995)/.010))*smooth((coss[j]-.25)/.28)
                color=tuple(round(a*(1-blend)+b*blend) for a,b in zip(yellow,cream))
            raw.extend((*color,255))
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw,9))+chunk(b'IEND',b'')
    texpath=HERE/'belly_basecolor.png';texpath.write_bytes(png)
    image=bpy.data.images.load(str(texpath),check_existing=False);image.pack()
    mat=bpy.data.materials.new('Naiwa • seamless cream belly');mat.use_nodes=True
    bs=mat.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Roughness'].default_value=.52;bs.inputs['Specular IOR Level'].default_value=.25
    tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image
    mat.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color'])
    bodyob.data.materials.clear();bodyob.data.materials.append(mat)
    for a in list(bodyob.data.color_attributes): bodyob.data.color_attributes.remove(a)
    uv=bodyob.data.uv_layers.new(name='BellyUV')
    coords=[]
    for i,p in enumerate(body.v):
        if body.colors[i]==DARK: coords.append((.25,.009))
        elif body.colors[i]==mix(YELLOW,LIP,.35): coords.append((.25,.026))
        else:
            rx,ry,cy=profile(p[2]);angle=math.atan2(p[0]/max(.001,rx),-(p[1]-cy)/max(.001,ry))
            coords.append((.5+angle/(2*PI),(p[2]-.20)/.85))
    for polygon in bodyob.data.polygons:
        us=[coords[bodyob.data.loops[i].vertex_index][0] for i in polygon.loop_indices]
        seam=max(us)-min(us)>.5
        for li in polygon.loop_indices:
            u,v=coords[bodyob.data.loops[li].vertex_index]
            if seam and u<.5: u+=1
            uv.data[li].uv=(u,v)
paint_body()

# Green-rimmed, round protruding eyes. The lids are skin-coloured flattened eye shells
# under blink/laugh, with a dark curved seam: the pupils do not remain floating in space.
eyes=Mesh('Eyes')
for side in (-1,1):
    ec=Vector((side*.070,front_y(.070,.925)+.006,.925))
    eye_rotation=Matrix.Rotation(side*math.radians(30),3,'Z')
    for part,scale,color in [('rim',(.029,.015,.032),YELLOW),('white',(.0265,.014,.029),WHITE),('iris',(.0245,.009,.027),IRIS),('pupil',(.0125,.005,.016),PUPIL)]:
        cen=ec.copy(); cen.y += {'rim':0,'white':-.003,'iris':-.014,'pupil':-.022}[part]
        def eye_transform(p,q,cen=cen,part=part,ec=ec,rotation=eye_rotation):
            result={s:ec+rotation@(p-ec) for s in STATES}
            for state in ('blink','laugh'):
                out=p.copy()
                if part=='rim':
                    out.z=ec.z+(p.z-ec.z)*.18
                    out.y=front_y(out.x,out.z)-.001+(p.y-cen.y)*.08
                else:
                    out.z=ec.z+(p.z-ec.z)*.035+.006*(q.x*q.x)
                    out.y=front_y(out.x,out.z)+.010+(p.y-cen.y)*.03
                result[state]=out
            result['surprise']=ec+rotation@(p-ec)*1.09
            return result
        ellipsoid(eyes,cen,scale,color,{'head':1},24,12,eye_transform)
    # Separate smooth crease hides under the open eye, then follows the skin when shut.
    rows=[]
    for j in range(25):
        u=-1+2*j/24
        row=[]
        for k in range(6):
            a=2*PI*k/6
            x=ec.x+side*.009+u*.026
            z=ec.z+.005*(1-u*u)+.0011*math.cos(a)
            fy=front_y(x,z)
            shapes={state:(x,fy+(.012 if state not in ('laugh','blink') else -.002)+.0011*math.sin(a),z) for state in STATES}
            row.append(eyes.vertex(shapes['Basis'],PUPIL,{'head':1},shapes=shapes))
        rows.append(row)
    for a,b in zip(rows,rows[1:]):
        for k in range(6): eyes.face(a[k],a[(k+1)%6],b[(k+1)%6],b[k])
    eyes.face(*reversed(rows[0]));eyes.face(*rows[-1])
eyesob=eyes.finish(eyemat)

# Rig, with real articulated palms and fingers.
bones={}
def bone(n,h,t,p=None): bones[n]=(Vector(h),Vector(t),p)
bone('root',(0,0,0),(0,0,.1))
bone('hips',(0,0,.31),(0,0,.49),'root')
bone('spine',(0,0,.49),(0,0,.67),'hips')
bone('chest',(0,0,.67),(0,-.035,.80),'spine')
bone('head',(0,-.035,.80),(0,-.08,.97),'chest')
for s,side in [(1,'L'),(-1,'R')]:
    shoulder=(s*.110,.005,.705); elbow=(s*.255,-.008,.560); wrist=(s*.325,-.04,.385)
    palm=(s*.340,-.05,.340)
    bone('upperarm_'+side,shoulder,elbow,'chest')
    bone('forearm_'+side,elbow,wrist,'upperarm_'+side)
    bone('hand_'+side,wrist,palm,'forearm_'+side)
    for name,off,length in [('index',-.024,.082),('middle',0,.088),('ring',.025,.067)]:
        h=(s*(.34+off),-.054,.347)
        t=(s*(.348+off*1.35),-.057,.347-length)
        bone(name+'_'+side,h,t,'hand_'+side)
    bone('thumb_'+side,(s*.313,-.063,.367),(s*.287,-.079,.324),'hand_'+side)
    bone('thigh_'+side,(s*.111,.008,.318),(s*.126,.012,.185),'hips')
    bone('shin_'+side,(s*.126,.012,.185),(s*.142,.004,.055),'thigh_'+side)
    bone('foot_'+side,(s*.142,.004,.055),(s*.148,-.103,.025),'shin_'+side)

def tube(mesh,points,radii,weights,colors,segments=16):
    rows=[]
    for j,(p,r,w,col) in enumerate(zip(points,radii,weights,colors)):
        p=Vector(p)
        tangent=(Vector(points[min(j+1,len(points)-1)])-Vector(points[max(0,j-1)])).normalized()
        ax=tangent.cross(Vector((0,1,0))).normalized(); ay=tangent.cross(ax).normalized()
        row=[]
        for i in range(segments):
            a=2*PI*i/segments
            row.append(mesh.vertex(p+r*(ax*math.cos(a)+ay*math.sin(a)),col,w))
        rows.append(row)
    for a,b in zip(rows,rows[1:]):
        for i in range(segments): mesh.face(a[i],a[(i+1)%segments],b[(i+1)%segments],b[i])
    for row,p,w,col in [(rows[0],points[0],weights[0],colors[0]),(rows[-1],points[-1],weights[-1],colors[-1])]:
        c=mesh.vertex(p,col,w)
        for i in range(segments): mesh.face(c,row[i],row[(i+1)%segments])

arms=Mesh('Arms'); legs=Mesh('Legs')
for s,side in [(1,'L'),(-1,'R')]:
    # A curved, uninterrupted sleeve, weighted over elbow and wrist support loops.
    upper='upperarm_'+side; fore='forearm_'+side; hand='hand_'+side
    sh,el,_=bones[upper]; _,wr,_=bones[fore]; _,pa,_=bones[hand]
    points=[]; radii=[]; ws=[]; cs=[]
    for j in range(23):
        t=j/22*2.35
        if t<=1: p=sh.lerp(el,t); radius=.045+.004*t+.020*math.sin(PI*t)
        elif t<=2: p=el.lerp(wr,t-1); radius=.049+.012*math.sin(PI*(t-1))-.016*(t-1)
        else: p=wr.lerp(pa,(t-2)/.35); radius=.035*(1-.30*(t-2)/.35)
        if t<.7: w={upper:1}
        elif t<1.3:
            a=smooth((t-.7)/.6); w={upper:1-a,fore:a}
        elif t<1.8: w={fore:1}
        elif t<2.2:
            a=smooth((t-1.8)/.4); w={fore:1-a,hand:a}
        else: w={hand:1}
        points.append(p);radii.append(radius);ws.append(w);cs.append(mix(YELLOW,OLIVE,smooth((t-1.9)/.3)))
    tube(arms,points,radii,ws,cs,20)
    ellipsoid(arms,pa+Vector((0,0,.012)),(.036,.023,.034),OLIVE,{hand:1},24,12)
    for finger in ('thumb','index','middle','ring'):
        n=finger+'_'+side; h,t,_=bones[n]; direction=t-h
        points=[h+direction*u+Vector((0,-.010*math.sin(PI*u/2)**2,0))*(1 if finger in ('thumb','ring') else .3) for u in (0,.15,.35,.6,.82,.94,1.)]
        radii=[.011,.0115,.0105,.0095,.009,.006,.001]
        ws=[{hand:1-u,n:u} for u in (0,.55,1,1,1,1,1)]
        tube(arms,points,radii,ws,[OLIVE]*len(points),12)
    thigh='thigh_'+side; shin='shin_'+side; foot='foot_'+side
    h,k,_=bones[thigh]; _,a,_=bones[shin]
    points=[];radii=[];ws=[];cs=[]
    for j in range(18):
        t=j/17*2
        p=h.lerp(k,t) if t<=1 else k.lerp(a,t-1)
        radius=.018+.059*(1-t/2)**1.6
        w={thigh:1} if t<.65 else ({shin:1} if t>1.35 else {thigh:1-smooth((t-.65)/.7),shin:smooth((t-.65)/.7)})
        points.append(p);radii.append(radius);ws.append(w);cs.append(mix(YELLOW,OLIVE,smooth((t-1.65)/.35)))
    tube(legs,points,radii,ws,cs,20)
    ellipsoid(legs,(s*.146,-.037,.028),(.047,.082,.028),OLIVE,{foot:1},28,12)
    for off,extension in [(-.028,.009),(0,.020),(.028,.012)]:
        ellipsoid(legs,(s*(.146+off),-.095-extension,.019),(.019,.033,.019),OLIVE,{foot:1},16,10)
armsob=arms.finish(skinmat); legsob=legs.finish(skinmat)

def fuse_limb_surface(ob, source, target_triangles):
    """Round the union of palm/fingers and ankle/toes; transfer painted weights.

    This is a geometric union before binding, not intersecting visible primitives.
    Nearest source-triangle barycentrics preserve the original joint transitions.
    """
    triangles=[]
    for face in source.f:
        triangles.extend((face[0],face[i],face[i+1]) for i in range(1,len(face)-1))
    vertices=[Vector(v) for v in source.v]
    tree=BVHTree.FromPolygons(vertices,triangles,all_triangles=True)
    ob.shape_key_clear()
    bpy.ops.object.select_all(action='DESELECT');ob.select_set(True)
    bpy.context.view_layer.objects.active=ob
    remesh=ob.modifiers.new('Continuous rounded limb surface','REMESH')
    remesh.mode='VOXEL';remesh.voxel_size=.0032
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    sm=ob.modifiers.new('Smooth voxel sampling','SMOOTH');sm.factor=.65;sm.iterations=7
    bpy.ops.object.modifier_apply(modifier=sm.name)
    tri_count=sum(len(p.vertices)-2 for p in ob.data.polygons)
    dec=ob.modifiers.new('Web topology budget','DECIMATE');dec.ratio=min(1,target_triangles/tri_count)
    bpy.ops.object.modifier_apply(modifier=dec.name)
    # Decimation otherwise leaves very large flat shoulder/hip cap triangles.
    # Split only long edges: this preserves the union surface and finger detail,
    # while giving the volume-cell sampler comparable spacing at buried roots.
    bm=bmesh.new();bm.from_mesh(ob.data)
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    for _ in range(5):
        long_edges=[e for e in bm.edges if e.calc_length()>(
            .012 if ob.name=='Arms' and min(v.co.z for v in e.verts)<.41 else
            (.016 if ob.name=='Legs' and min(v.co.z for v in e.verts)<.11 else .023))]
        if not long_edges: break
        mid={frozenset(edge.verts):bm.verts.new((edge.verts[0].co+edge.verts[1].co)/2) for edge in long_edges}
        for face in list(bm.faces):
            v=list(face.verts)
            splits=[mid.get(frozenset((v[i],v[(i+1)%3]))) for i in range(3)]
            count=sum(p is not None for p in splits)
            if not count: continue
            if count==1:
                i=next(i for i,p in enumerate(splits) if p is not None)
                a,b,c=v[i],v[(i+1)%3],v[(i+2)%3];m=splits[i]
                split_faces=[(a,m,c),(m,b,c)]
            elif count==2:
                i=next(i for i in range(3) if splits[i] is not None and splits[(i-1)%3] is not None)
                a,b,c=v[i],v[(i+1)%3],v[(i+2)%3];m,n=splits[i],splits[(i-1)%3]
                split_faces=[(a,m,n),(m,b,c),(m,c,n)]
            else:
                a,b,c=v;m,n,p=splits
                split_faces=[(a,m,p),(m,b,n),(p,n,c),(m,n,p)]
            bm.faces.remove(face)
            for triangle in split_faces: bm.faces.new(triangle)
        for edge in list(bm.edges):
            if not edge.link_faces: bm.edges.remove(edge)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(ob.data);bm.free();ob.data.update()
    ob.vertex_groups.clear()
    groups={n:ob.vertex_groups.new(name=n) for n in sorted({n for w in source.weights for n in w})}
    for attr in list(ob.data.color_attributes): ob.data.color_attributes.remove(attr)
    color=ob.data.color_attributes.new(name='Color',type='FLOAT_COLOR',domain='POINT')
    for vertex in ob.data.vertices:
        p,normal,idx,dist=tree.find_nearest(vertex.co)
        ia,ib,ic=triangles[idx];a,b,c=[vertices[i] for i in (ia,ib,ic)]
        v0=b-a;v1=c-a;v2=p-a
        d00=v0.dot(v0);d01=v0.dot(v1);d11=v1.dot(v1);d20=v2.dot(v0);d21=v2.dot(v1)
        denom=d00*d11-d01*d01
        if abs(denom)<1e-15: bary=[1,0,0]
        else:
            v=(d11*d20-d01*d21)/denom;w=(d00*d21-d01*d20)/denom
            bary=[clamp(1-v-w),clamp(v),clamp(w)];total=sum(bary);bary=[b/total for b in bary]
        weights={};col=Vector()
        for i,bw in zip((ia,ib,ic),bary):
            col+=Vector(source.colors[i])*bw
            for name,w in source.weights[i].items(): weights[name]=weights.get(name,0)+w*bw
        largest=sorted(weights.items(),key=lambda kv:-kv[1])[:4];total=sum(w for _,w in largest)
        for name,w in largest:
            if w>1e-6: groups[name].add([vertex.index],w/total,'REPLACE')
        if ob.name=='Legs':
            col=Vector(mix(YELLOW,OLIVE,smooth((.10-vertex.co.z)/.065)))
            side='L' if vertex.co.x>0 else 'R'
            foot_weight=1-smooth((vertex.co.z-.035)/.055)
            if vertex.co.z<.09:
                for group in groups.values(): group.remove([vertex.index])
                groups['shin_'+side].add([vertex.index],1-foot_weight,'REPLACE')
                groups['foot_'+side].add([vertex.index],foot_weight,'REPLACE')
        color.data[vertex.index].color=(*col,1)
    for polygon in ob.data.polygons: polygon.use_smooth=True

fuse_limb_surface(armsob,arms,7000)
fuse_limb_surface(legsob,legs,5000)

mouth=Mesh('MouthInside')
for i in range(9):
    u=(i-4)/4*.82
    def tooth_shape(p,q,u=u):
        result={}
        for state in STATES:
            w,h,c=MOUTH[state]
            top=math.sqrt(max(0,1-u*u))
            lp=lip_point(u,.88*top,state)
            lp.y+=.010
            height=.012 if state in ('laugh','tongue') else .0009
            # Neutral teeth are folded inside the pocket, behind the closed lips.
            if state in ('Basis','blink','surprise'): lp.y+=.090
            qx=math.copysign(abs(q.x)**.55,q.x); qz=math.copysign(abs(q.z)**.55,q.z)
            result[state]=lp+Vector((qx*w*.100,q.y*.006,qz*height*.5-height*.4))
        return result
    shape=tooth_shape(Vector(),Vector())['Basis']
    ellipsoid(mouth,shape,(.007,.005,.005),WHITE,{'head':1},12,8,tooth_shape)
for i in range(6):
    u=(i-2.5)/2.5*.58
    def lower_tooth(p,q,u=u):
        result={}
        for state in STATES:
            lp=lip_point(u,-.91*math.sqrt(1-u*u),state)
            visible=state=='laugh'
            lp.y+=.011 if visible else .110
            height=.007 if visible else .0005
            result[state]=lp+Vector((math.copysign(abs(q.x)**.55,q.x)*.008,q.y*.004,q.z*height*.5+height*.35))
        return result
    center=lower_tooth(Vector(),Vector())['Basis']
    ellipsoid(mouth,center,(.006,.004,.0005),WHITE,{'head':1},12,8,lower_tooth)
def tongue_shape(p,q):
    result={}
    for state in STATES:
        w,h,c=MOUTH[state]
        if state=='tongue':
            result[state]=Vector((q.x*.038,-.193+q.y*.016-.018*(1-q.z*q.z),.806+q.z*.045))
        elif state=='laugh': result[state]=Vector((q.x*.025,-.118+q.y*.009,.790+q.z*.009))
        else: result[state]=Vector((q.x*.018,-.105+q.y*.006,.845+q.z*.001))
    return result
ellipsoid(mouth,(0,-.105,.845),(.018,.006,.001),PINK,{'head':1},32,18,tongue_shape)
mouthob=mouth.finish(mouthmat)

armdata=bpy.data.armatures.new('NaiwaSkeleton')
rig=bpy.data.objects.new('NaiwaRig',armdata);bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active=rig;rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for name,(h,t,p) in bones.items():
    b=armdata.edit_bones.new(name);b.head=h;b.tail=t
    if p: b.parent=armdata.edit_bones[p]
    b.align_roll(Vector((0,-1,0)))
bpy.ops.object.mode_set(mode='OBJECT')
objects=[bodyob,eyesob,armsob,legsob,mouthob]
for ob in objects:
    mod=ob.modifiers.new('Skeleton','ARMATURE');mod.object=rig
    mod.use_deform_preserve_volume=True
    ob.parent=rig
    ob['character']='奶蛙'
rig['units']='meters';rig['forward']='+Z in glTF';rig['version']='reference reconstruction 1'

def refine_joint_weights():
    """Broad, smooth joint support without changing the preferred limb silhouette.

    glTF stores ordinary weights; the playground can use them for dual-quaternion
    targets or physical attachment. Both LBS and DQ are checked independently.
    """
    for ob in (armsob,legsob):
        original_weights=[{ob.vertex_groups[g.group].name:g.weight for g in v.groups} for v in ob.data.vertices]
        original_positions=[v.co.copy() for v in ob.data.vertices]
        for v,p,weights in zip(ob.data.vertices,original_positions,original_weights):
            side='L' if p.x>0 else 'R'
            first,second=('upperarm_'+side,'forearm_'+side) if ob==armsob else ('thigh_'+side,'shin_'+side)
            mass=weights.get(first,0)+weights.get(second,0)
            if mass>.001:
                candidates=[]
                for n,offset in [(first,0),(second,1)]:
                    a,b,_=bones[n];delta=b-a
                    t=clamp((p-a).dot(delta)/delta.length_squared)
                    center=a+t*delta
                    candidates.append(((p-center).length,offset+t,center))
                _,t,center=min(candidates,key=lambda x:x[0])
                w=smooth((t-.25)/1.5)
                ob.vertex_groups[first].add([v.index],mass*(1-w),'REPLACE')
                ob.vertex_groups[second].add([v.index],mass*w,'REPLACE')
                if ob==armsob and mass>.9:
                    # A modest anatomical elbow waist clears inner skin folds
                    # in both DQ and LBS, without thinning the biceps or legs.
                    radius=1-.16*math.exp(-((t-1)/.43)**2)
                    v.co=center+(p-center)*radius
                if ob==armsob and t<.28:
                    # The sleeve emerges from a chest-anchored buried root.
                    chest_weight=.8*(1-smooth(t/.28))*mass
                    if 'chest' not in ob.vertex_groups: ob.vertex_groups.new(name='chest')
                    ob.vertex_groups['chest'].add([v.index],chest_weight,'REPLACE')
                    ob.vertex_groups[first].add([v.index],mass*(1-w)-chest_weight,'REPLACE')
            finger_groups=[(n,w) for n,w in weights.items() if n.startswith(('index_','middle_','ring_','thumb_')) and w>1e-6]
            if finger_groups:
                n=max(finger_groups,key=lambda x:x[1])[0];a,b,_=bones[n];delta=b-a
                t=(p-a).dot(delta)/delta.length_squared;w=smooth(t)
                for group,_ in finger_groups: ob.vertex_groups[group].add([v.index],0,'REPLACE')
                ob.vertex_groups[n].add([v.index],w,'REPLACE')
                ob.vertex_groups['hand_'+side].add([v.index],1-w,'REPLACE')
        ob.data.update()
    # Smoothing the union must not leave hovering soles.
    for sign in (-1,1):
        vertices=[v for v in legsob.data.vertices if v.co.x*sign>0]
        bottom=min(v.co.z for v in vertices)
        for v in vertices: v.co.z-=bottom*(1-smooth((v.co.z-.04)/.06))
refine_joint_weights()

def finish_flesh_binding(ob):
    """Remove transfer discontinuities and paint stiffness on every limb shell."""
    neighbors=[set() for _ in ob.data.vertices]
    for edge in ob.data.edges:
        a,b=edge.vertices;neighbors[a].add(b);neighbors[b].add(a)
    weights=[{g.group:g.weight for g in v.groups if g.weight>1e-6} for v in ob.data.vertices]
    for _ in range(2):
        updated=[]
        for i,own in enumerate(weights):
            blended={g:w*.7 for g,w in own.items()}
            for j in neighbors[i]:
                for g,w in weights[j].items(): blended[g]=blended.get(g,0)+w*.3/len(neighbors[i])
            kept=sorted(((g,w) for g,w in blended.items() if w>=1e-4),key=lambda item:-item[1])[:4]
            total=sum(w for _,w in kept)
            updated.append({g:w/total for g,w in kept})
        weights=updated
    if ob==armsob:
        # The thumb web needs finer falloff than nearest-triangle transfer.
        # Distance-weighted diffusion respects the short finger edges and leaves
        # the upper arm/elbow field alone; each pass retains four influences.
        kernels=[]
        for i,adjacent in enumerate(neighbors):
            kernel={j:1/max((ob.data.vertices[i].co-ob.data.vertices[j].co).length,.0005)**2 for j in adjacent}
            total=sum(kernel.values());kernels.append({j:value/total for j,value in kernel.items()})
        for _ in range(24):
            updated=[]
            for i,own in enumerate(weights):
                gain=.45*smooth((.44-ob.data.vertices[i].co.z)/.04)
                blended={g:w*(1-gain) for g,w in own.items()}
                for j,kernel in kernels[i].items():
                    for g,w in weights[j].items(): blended[g]=blended.get(g,0)+w*gain*kernel
                kept=sorted(((g,w) for g,w in blended.items() if w>=1e-6),key=lambda item:-item[1])[:4]
                total=sum(w for _,w in kept);updated.append({g:w/total for g,w in kept})
            weights=updated
    else:
        # Re-evaluate the ankle field analytically after mesh sampling. Uniform
        # graph smoothing can otherwise bias weights at unequal-valence toes.
        for vertex in ob.data.vertices:
            if vertex.co.z<.10:
                side='L' if vertex.co.x>0 else 'R'
                foot=1-smooth((vertex.co.z-.030)/.070)
                weights[vertex.index]={ob.vertex_groups['shin_'+side].index:1-foot,
                                       ob.vertex_groups['foot_'+side].index:foot}
    attr=ob.data.attributes.get('_softness') or ob.data.attributes.new('_softness','FLOAT','POINT')
    for v,w in zip(ob.data.vertices,weights):
        for group in ob.vertex_groups: group.remove([v.index])
        for g,value in w.items(): ob.vertex_groups[g].add([v.index],value,'REPLACE')
        firm=sum(value for g,value in w.items() if ob.vertex_groups[g].name.startswith(('hand_','thumb_','index_','middle_','ring_','foot_')))
        attr.data[v.index].value=.5-.35*firm
    ob.data.update()
for ob in (armsob,legsob): finish_flesh_binding(ob)

def validate():
    bm=bmesh.new();bm.from_mesh(bodyob.data)
    bad=[e.index for e in bm.edges if not e.is_manifold]
    components=0;seen=set()
    for v in bm.verts:
        if v in seen: continue
        components+=1; stack=[v];seen.add(v)
        while stack:
            for e in stack.pop().link_edges:
                for vv in e.verts:
                    if vv not in seen: seen.add(vv);stack.append(vv)
    volume=bm.calc_volume(signed=True);bm.free()
    tris={o.name:sum(len(p.vertices)-2 for p in o.data.polygons) for o in objects}
    assert not bad, f'Body has {len(bad)} non-manifold edges'
    assert components==1, f'Body has {components} components'
    assert volume>0, 'Body winding is inverted'
    assert 3000<=tris['Body']<=12000, tris
    assert sum(tris.values())<=40000, tris
    flesh={}
    for ob,expected in ((bodyob,1),(armsob,2),(legsob,2)):
        bm=bmesh.new();bm.from_mesh(ob.data)
        assert all(e.is_manifold for e in bm.edges),f'{ob.name}: open/nonmanifold edge'
        seen=set();parts=[]
        for vertex in bm.verts:
            if vertex in seen: continue
            stack=[vertex];seen.add(vertex);part=[]
            while stack:
                current=stack.pop();part.append(current)
                for edge in current.link_edges:
                    other=edge.other_vert(current)
                    if other not in seen: seen.add(other);stack.append(other)
            parts.append(part)
        assert len(parts)==expected,f'{ob.name}: expected {expected} closed shells, got {len(parts)}'
        assert bm.calc_volume(signed=True)>0,f'{ob.name}: inverted surface'
        bm.free()
        softness=ob.data.attributes.get('_softness')
        assert softness and softness.domain=='POINT' and len(softness.data)==len(ob.data.vertices),f'{ob.name}: missing per-vertex softness'
        values=[value.value for value in softness.data]
        assert all(math.isfinite(v) and 0<=v<=1 for v in values)
        for vertex in ob.data.vertices:
            weights=[g.weight for g in vertex.groups if g.weight>1e-6]
            assert len(weights)<=4 and abs(sum(weights)-1)<1e-5,f'{ob.name}: invalid binding at vertex {vertex.index}'
        flesh[ob.name]={'closed_shells':len(parts),'softness_range':[min(values),max(values)],
                        'max_influences':max(sum(g.weight>1e-6 for g in v.groups) for v in ob.data.vertices)}
    report={'triangles':tris,'total_triangles':sum(tris.values()),'body_components':components,
            'body_nonmanifold_edges':len(bad),'body_volume_m3':volume,'bones':list(bones),
            'flesh':flesh,'evidence_skinning':'dual quaternion; ordinary normalized glTF weights exported',
            'shape_keys':{o.name:list(o.data.shape_keys.key_blocks.keys()) if o.data.shape_keys else [] for o in objects}}
    (HERE/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
    print('NAIWA VALIDATION',json.dumps(report))
validate()
OUT.parent.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='DESELECT')
for ob in [rig]+objects: ob.select_set(True)
bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=str(OUT),export_format='GLB',use_selection=True,
    export_yup=True,export_animations=False,export_skins=True,export_morph=True,
    export_attributes=True,export_extras=True,export_apply=False,
    export_all_influences=False,export_def_bones=True,export_materials='EXPORT')
print('NAIWA EXPORTED',OUT)

def reset():
    for pb in rig.pose.bones:
        pb.rotation_mode='QUATERNION';pb.rotation_quaternion=Quaternion();pb.location=(0,0,0);pb.scale=(1,1,1)
    for ob in objects:
        if ob.data.shape_keys:
            for k in ob.data.shape_keys.key_blocks: k.value=0
    bpy.context.view_layer.update()

def expression(state):
    for ob in objects:
        if ob.data.shape_keys and state in ob.data.shape_keys.key_blocks: ob.data.shape_keys.key_blocks[state].value=1

def aim_bone(name,target,roll=0):
    bpy.context.view_layer.update()
    pb=rig.pose.bones[name]
    origin=pb.head.copy()
    yy=(Vector(target)-origin).normalized()
    zz=Vector((0,-1,0)); zz=(zz-yy*zz.dot(yy)).normalized()
    xx=yy.cross(zz).normalized()
    mat=Matrix((xx,yy,zz)).transposed().to_4x4();mat.translation=origin
    pb.matrix=mat
    if roll: pb.rotation_quaternion @= Quaternion((0,1,0),roll)
    bpy.context.view_layer.update()

def skin_point(p):
    result=Vector();transforms=[]
    for name,weight in body_weights(p.z).items():
        matrix=rig.pose.bones[name].matrix @ rig.data.bones[name].matrix_local.inverted()
        result+=(matrix @ p)*weight;transforms.append((matrix,weight))
    if not bodyob.modifiers['Skeleton'].use_deform_preserve_volume: return result
    real=[0.]*4;dual=[0.]*4;reference=None
    for matrix,weight in transforms:
        q=matrix.to_quaternion();t=matrix.translation
        d=Quaternion((0.,t.x,t.y,t.z)) @ q
        if reference is None: reference=q.copy()
        sign=1 if reference.dot(q)>=0 else -1
        for i in range(4): real[i]+=weight*sign*q[i];dual[i]+=.5*weight*sign*d[i]
    norm=math.sqrt(sum(x*x for x in real))
    q=Quaternion(tuple(x/norm for x in real));d=Quaternion(tuple(x/norm for x in dual))
    translation=d @ q.conjugated()
    return q @ p+2*Vector(tuple(translation)[1:])

def solve_arm(side,target,pole):
    bpy.context.view_layer.update()
    upper=rig.pose.bones['upperarm_'+side];fore=rig.pose.bones['forearm_'+side]
    origin=upper.head.copy();delta=target-origin
    d=clamp(delta.length,.02,upper.length+fore.length-.001)
    axis=delta.normalized()
    along=(upper.length**2-fore.length**2+d*d)/(2*d)
    height=math.sqrt(max(0,upper.length**2-along**2))
    outward=pole-origin-axis*(pole-origin).dot(axis);outward.normalize()
    elbow=origin+axis*along+outward*height
    aim_bone('upperarm_'+side,elbow)
    aim_bone('forearm_'+side,target)

def solve_leg(side,target,pole):
    bpy.context.view_layer.update()
    thigh=rig.pose.bones['thigh_'+side];shin=rig.pose.bones['shin_'+side]
    origin=thigh.head.copy();delta=target-origin
    d=clamp(delta.length,.02,thigh.length+shin.length-.0001)
    axis=delta.normalized()
    along=(thigh.length**2-shin.length**2+d*d)/(2*d)
    height=math.sqrt(max(0,thigh.length**2-along**2))
    outward=pole-origin-axis*(pole-origin).dot(axis);outward.normalize()
    knee=origin+axis*along+outward*height
    aim_bone('thigh_'+side,knee)
    aim_bone('shin_'+side,target)
    aim_bone('foot_'+side,rig.pose.bones['foot_'+side].head+Vector((0,-.107,-.030)))

def pose(name):
    reset()
    if name=='laugh':
        expression('laugh')
        rig.pose.bones['hips'].rotation_quaternion=Quaternion((1,0,0),math.radians(12))
        rig.pose.bones['spine'].rotation_quaternion=Quaternion((1,0,0),math.radians(14))
        rig.pose.bones['chest'].rotation_quaternion=Quaternion((1,0,0),math.radians(14))
        rig.pose.bones['head'].rotation_quaternion=Quaternion((1,0,0),math.radians(-22))
    if name in ('holding','laugh'):
        bpy.context.view_layer.update()
        for side_sign,side in [(1,'L'),(-1,'R')]:
            if name=='laugh': solve_leg(side,Vector((side_sign*.142,.004,.055)),Vector((side_sign*.20,-.40,.18)))
            z=.51 if name=='holding' else .48
            target=skin_point(Vector((side_sign*.14,front_y(.14,z)-.037,z)))
            pole=Vector((side_sign*.43,-.005,.54 if name=='holding' else .49))
            solve_arm(side,target,pole)
            finger_target=skin_point(Vector((side_sign*.035,front_y(.035,z-.025)-.040,z-.025)))
            aim_bone('hand_'+side,finger_target)
    elif name=='peace':
        expression('tongue')
        rig.pose.bones['head'].rotation_quaternion=Quaternion((0,0,1),math.radians(-6))
        for side_sign,side in [(1,'L'),(-1,'R')]:
            wrist_height=.89+(.020 if side=='R' else -.015)
            solve_arm(side,Vector((side_sign*.28,-.075,wrist_height)),Vector((side_sign*.40,.01,.62)))
            aim_bone('hand_'+side,(side_sign*.28,-.075,wrist_height+.11))
            for fn,spread,length in [('index',.020,.082),('middle',-.020,.088)]:
                pb=rig.pose.bones[fn+'_'+side]
                aim_bone(fn+'_'+side,pb.head+Vector((side_sign*spread,-.003,length)))
            rig.pose.bones['ring_'+side].rotation_quaternion=Quaternion((1,0,0),math.radians(80))
            rig.pose.bones['thumb_'+side].rotation_quaternion=Quaternion((1,0,0),math.radians(30))
    elif name in ('tongue','blink','surprise'): expression(name)
    elif name in ('deep_bend','arms_up','belly_cross','squat','leg_lift','hop','twist'):
        if name=='deep_bend':
            rig.pose.bones['hips'].rotation_quaternion=Quaternion((1,0,0),math.radians(48))
            rig.pose.bones['spine'].rotation_quaternion=Quaternion((1,0,0),math.radians(12))
            rig.pose.bones['chest'].rotation_quaternion=Quaternion((1,0,0),math.radians(10))
        elif name=='squat':
            rig.pose.bones['root'].location.y=-.100
            rig.pose.bones['hips'].rotation_quaternion=Quaternion((1,0,0),math.radians(15))
            rig.pose.bones['chest'].rotation_quaternion=Quaternion((1,0,0),math.radians(-8))
        elif name=='hop':
            rig.pose.bones['root'].location.y=.18
        elif name=='twist':
            rig.pose.bones['spine'].rotation_quaternion=Quaternion((0,1,0),math.radians(20))
            rig.pose.bones['chest'].rotation_quaternion=Quaternion((0,1,0),math.radians(25))
            rig.pose.bones['head'].rotation_quaternion=Quaternion((0,1,0),math.radians(-10))
        bpy.context.view_layer.update()
        for side_sign,side in [(1,'L'),(-1,'R')]:
            ankle=Vector((side_sign*.142,.004,.055))
            if name=='leg_lift' and side=='L': ankle=Vector((.16,-.215,.245))
            elif name=='hop': ankle=Vector((side_sign*.16,.06,.225))
            elif name=='squat': ankle=Vector((side_sign*.18,-.005,.055))
            if name in ('deep_bend','squat','leg_lift','hop'):
                solve_leg(side,ankle,Vector((side_sign*.21,-.45,.22)))
            if name in ('arms_up','hop'):
                target=Vector((side_sign*.23,-.03,1.06+(.1 if name=='hop' else 0)))
                solve_arm(side,target,Vector((side_sign*.50,-.02,.85)))
                aim_bone('hand_'+side,rig.pose.bones['hand_'+side].head+Vector((0,0,.1)))
            elif name in ('belly_cross','deep_bend'):
                z=(.53 if name=='deep_bend' else .49)+(.02 if side=='L' else -.02)
                target=skin_point(Vector((side_sign*.14,front_y(.14,z)-.045,z)))
                solve_arm(side,target,Vector((side_sign*.45,-.06,.50)))
                aim_bone('hand_'+side,skin_point(Vector((-side_sign*.045,front_y(.045,z)-.047,z))))
            elif name=='squat':
                solve_arm(side,Vector((side_sign*.31,-.11,.43)),Vector((side_sign*.47,-.01,.55)))
            elif name=='leg_lift':
                solve_arm(side,Vector((side_sign*.39,-.01,.76)),Vector((side_sign*.48,.01,.62)))
    bpy.context.view_layer.update()

def studio():
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=48
    scene.cycles.use_denoising=True
    try:
        prefs=bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type='OPTIX';prefs.get_devices()
        for d in prefs.devices: d.use=(d.type=='OPTIX')
        scene.cycles.device='GPU'
    except Exception as e: print('GPU setup:',e)
    scene.render.resolution_x=700;scene.render.resolution_y=800;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'
    scene.world.color=(.8,.8,.8)
    scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.78,.80,.84,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.4
    scene.view_settings.view_transform='Standard'
    scene.view_settings.exposure=-.60
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.002))
    ground=bpy.context.object;ground.name='StudioFloor'
    mat=bpy.data.materials.new('Studio white');mat.diffuse_color=(.91,.91,.89,1);mat.use_nodes=True
    mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.91,.91,.89,1)
    mat.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value=(1,1,1,1)
    mat.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value=.45
    ground.data.materials.append(mat)
    for name,loc,power,size in [('Key',(-2,-3,4),180,2.5),('Fill',(2,-1,2),45,2.5),('Rim',(0,2,3),100,2.)]:
        data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size
        ob=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(ob);ob.location=loc
        ob.rotation_euler=(Vector((0,0,.5))-ob.location).to_track_quat('-Z','Y').to_euler()
    camdata=bpy.data.cameras.new('EvidenceCamera');cam=bpy.data.objects.new('EvidenceCamera',camdata)
    bpy.context.collection.objects.link(cam);scene.camera=cam;camdata.type='ORTHO';camdata.lens=65
    return scene,cam

def render_all():
    RENDERS.mkdir(exist_ok=True)
    scene,cam=studio()
    shots=[('01_holding_side','holding',(4.5,-2.2,1.3),(0,-.015,.50),1.18),
           ('02_belly_laugh','laugh',(1.9,-3.7,1.4),(0,-.08,.57),.98),
           ('03_peace_tongue','peace',(0,-4,1.0),(0,-.025,.75),.78),
           ('04_rest_front','rest',(0,-4,1.15),(0,0,.51),1.16),
           ('05_rest_back','rest',(0,4,1.4),(0,0,.51),1.16),
           ('06_rest_profile','rest',(-4,0,1.3),(0,0,.51),1.16),
           ('07_surprise','surprise',(0,-4,1.2),(0,-.06,.84),.48),
           ('08_blink','blink',(0,-4,1.2),(0,-.06,.84),.48)]
    shots += [('stress_'+name,name,loc,(0,-.05,.55),scale) for name,loc,scale in [
        ('deep_bend',(2.8,-3.8,1.6),1.25),('arms_up',(1.2,-4,1.3),1.43),
        ('belly_cross',(0,-4,1.25),1.17),('squat',(1.8,-4,1.4),1.17),
        ('leg_lift',(1.8,-4,1.3),1.20),('hop',(1.6,-4,1.5),1.55),
        ('twist',(1.5,-4,1.5),1.20)]]
    for filename,pose_name,loc,target,scale in shots:
        scene.render.resolution_x=800 if filename=='03_peace_tongue' else 700
        pose(pose_name);cam.location=loc;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler()
        cam.data.ortho_scale=scale
        scene.render.filepath=str(RENDERS/(filename+'.png'))
        bpy.ops.render.render(write_still=True)
        print('NAIWA RENDERED',filename,flush=True)
    reset()
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE/'naiwa.blend'))

if '--renders' in sys.argv: render_all()
