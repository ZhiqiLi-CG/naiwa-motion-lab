"""Independent exported-asset and posed-surface checks for the Naiwa contract.

    blender -b -t 2 -P assets-src/naiwa/validate_naiwa.py
    blender -b -t 2 -P assets-src/naiwa/validate_naiwa.py -- --stress

Reads the GLB directly, including sparse morph accessors and quarter-step Body
morph samples. Stress mode opens the
saved authoring blend and evaluates only the builder's named pose functions;
it also samples rest-to-pose quaternion slerps at .25, .5, and .75;
it never executes construction/export code or writes the blend/GLB. Report:
assets-src/naiwa/independent-validation.json. Exit code is nonzero on failures.
UV seam duplicates are geometrically welded to 1 micrometre for topology tests.
Self intersections use Blender's triangle BVH plus a coplanar 2D test; incident
triangles (sharing any welded vertex) are excluded. This is a discrete check, not continuous
collision detection between poses, and visual deformation review is still needed.
"""
import argparse
import ast
from collections import Counter, defaultdict
import hashlib
import itertools
import json
import math
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MESH_NAMES = {'Body', 'Eyes', 'Arms', 'Legs', 'MouthInside'}
FLESH_NAMES = {'Body', 'Arms', 'Legs'}
EXPECTED_COMPONENTS = {'Body': 1, 'Arms': 2, 'Legs': 2}
MORPH_NAMES = {'laugh', 'tongue', 'surprise', 'blink'}
INTERMEDIATE_FACTORS = (.25, .5, .75)
PARENTS = {'hips': 'root', 'spine': 'hips', 'chest': 'spine', 'head': 'chest'}
for side in ('L', 'R'):
    for child, parent in [('upperarm', 'chest'), ('forearm', 'upperarm'),
                          ('hand', 'forearm'), ('thigh', 'hips'),
                          ('shin', 'thigh'), ('foot', 'shin')]:
        PARENTS[child+'_'+side] = parent if parent in ('hips', 'chest') else parent+'_'+side
OPTIONAL_PARENTS = {finger+'_'+side: 'hand_'+side
                    for side in ('L', 'R') for finger in ('thumb', 'index', 'middle', 'ring')}


class GLB:
    def __init__(self, path):
        self.path = path
        self.data = path.read_bytes()
        magic, version, length = struct.unpack_from('<4sII', self.data)
        assert magic == b'glTF' and version == 2 and length == len(self.data), 'Invalid GLB 2 header'
        at = 12
        while at < len(self.data):
            size, kind = struct.unpack_from('<II', self.data, at)
            chunk = self.data[at+8:at+8+size]
            if kind == 0x4E4F534A:
                self.doc = json.loads(chunk)
            elif kind == 0x004E4942:
                self.binary = chunk
            at += size+8
        self.parent = {child: i for i, n in enumerate(self.doc['nodes']) for child in n.get('children', [])}
        self.world_cache = {}

    def read_view(self, view_id, component_type, width, count, offset=0):
        view = self.doc['bufferViews'][view_id]
        assert view.get('buffer', 0) == 0, 'External buffer is not supported by this GLB validator'
        fmt = '<'+{5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}[component_type]*width
        step = view.get('byteStride', struct.calcsize(fmt))
        offset += view.get('byteOffset', 0)
        return [struct.unpack_from(fmt, self.binary, offset+k*step) for k in range(count)]

    def accessor(self, index):
        a = self.doc['accessors'][index]
        width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
        values = (self.read_view(a['bufferView'], a['componentType'], width, a['count'], a.get('byteOffset', 0))
                  if 'bufferView' in a else [(0,)*width for _ in range(a['count'])])
        if 'sparse' in a:
            sparse = a['sparse']
            ii, vv = sparse['indices'], sparse['values']
            indices = self.read_view(ii['bufferView'], ii['componentType'], 1, sparse['count'], ii.get('byteOffset', 0))
            replacements = self.read_view(vv['bufferView'], a['componentType'], width, sparse['count'], vv.get('byteOffset', 0))
            for (i,), value in zip(indices, replacements):
                values[i] = value
        if a.get('normalized'):
            divisor = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535}[a['componentType']]
            values = [tuple(max(-1, v/divisor) for v in value) for value in values]
        return values

    def world(self, index):
        if index not in self.world_cache:
            n = self.doc['nodes'][index]
            if 'matrix' in n:
                m = Matrix([n['matrix'][i:i+4] for i in range(0, 16, 4)]).transposed()
            else:
                x, y, z, w = n.get('rotation', (0, 0, 0, 1))
                m = Matrix.LocRotScale(Vector(n.get('translation', (0, 0, 0))), Quaternion((w, x, y, z)), Vector(n.get('scale', (1, 1, 1))))
            if index in self.parent:
                m = self.world(self.parent[index]) @ m
            self.world_cache[index] = m
        return self.world_cache[index]


def coplanar_overlaps(vertices, triangles, welded_triangles):
    """Supplement BVHTree, whose overlap method omits coplanar triangle pairs.

    Plane bins are only a broad phase. Final tests require parallel normals,
    plane coincidence within 10 nm, overlapping bounding boxes, and 2D SAT.
    Neighbor bins avoid losing equal planes on quantization boundaries.
    """
    buckets = defaultdict(list)
    prepared = []
    pairs = set()
    offsets = tuple(itertools.product((-1, 0, 1), repeat=4))
    for index, tri in enumerate(triangles):
        points = tuple(vertices[i] for i in tri)
        normal = (points[1]-points[0]).cross(points[2]-points[0])
        if normal.length < 2e-12:
            prepared.append(None)
            continue
        normal.normalize()
        axis = max(range(3), key=lambda k: abs(normal[k]))
        if normal[axis] < 0:
            normal.negate()
        distance = normal.dot(points[0])
        key = tuple(int(round(v/1e-5)) for v in (*normal, distance))
        low = tuple(min(p[k] for p in points) for k in range(3))
        high = tuple(max(p[k] for p in points) for k in range(3))
        for delta in offsets:
            adjacent_key = tuple(a+b for a, b in zip(key, delta))
            for other in buckets.get(adjacent_key, ()):
                if set(welded_triangles[index]) & set(welded_triangles[other]):
                    continue
                other_points, other_normal, other_low, other_high = prepared[other]
                if any(low[k] > other_high[k]+1e-9 or other_low[k] > high[k]+1e-9 for k in range(3)):
                    continue
                if normal.cross(other_normal).length > 1e-6:
                    continue
                if max(abs(normal.dot(p)-distance) for p in other_points) > 1e-8:
                    continue
                axes = [k for k in range(3) if k != axis]
                a = [Vector((p[axes[0]], p[axes[1]])) for p in points]
                b = [Vector((p[axes[0]], p[axes[1]])) for p in other_points]
                separated = False
                for polygon in (a, b):
                    for i in range(3):
                        edge = polygon[(i+1)%3]-polygon[i]
                        perpendicular = Vector((-edge.y, edge.x)).normalized()
                        aa = [p.dot(perpendicular) for p in a]
                        bb = [p.dot(perpendicular) for p in b]
                        if max(aa) < min(bb)-1e-9 or max(bb) < min(aa)-1e-9:
                            separated = True
                            break
                    if separated:
                        break
                if not separated:
                    pairs.add((other, index))
        buckets[key].append(index)
        prepared.append((points, normal, low, high))
    return pairs


def distribution(values):
    values = sorted(values)
    if not values:
        return {'count': 0}
    def percentile(p):
        offset = (len(values)-1)*p
        lo = int(offset)
        hi = min(lo+1, len(values)-1)
        return values[lo]*(hi-offset)+values[hi]*(offset-lo) if lo != hi else values[lo]
    mean = sum(values)/len(values)
    return {'count': len(values), 'min': values[0], 'p01': percentile(.01), 'p05': percentile(.05),
            'p50': percentile(.5), 'p95': percentile(.95), 'p99': percentile(.99), 'max': values[-1],
            'mean': mean, 'coefficient_of_variation': (sum((v-mean)**2 for v in values)/len(values))**.5/mean if mean else 0}


def skin_weight_report(vertices, triangles, weights):
    """Rest-surface smoothness diagnostics; gradients are per metre, not per edge."""
    representatives = {}
    ids = []
    seam_disagreement = 0.
    for i, p in enumerate(vertices):
        key = tuple(round(float(c), 6) for c in p)
        if key in representatives:
            other = representatives[key]
            seam_disagreement = max(seam_disagreement, sum(abs(weights[i].get(n, 0)-weights[other].get(n, 0))
                                                            for n in weights[i].keys() | weights[other].keys()))
        else:
            representatives[key] = i
        ids.append(representatives[key])
    edges = {tuple(sorted((ids[a], ids[b]))) for tri in triangles
             for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])) if ids[a] != ids[b]}
    jumps, gradients, ranked_edges = [], [], []
    regional = defaultdict(list)
    for a, b in edges:
        delta = sum(abs(weights[a].get(n, 0)-weights[b].get(n, 0)) for n in weights[a].keys() | weights[b].keys())
        length = (vertices[a]-vertices[b]).length
        jumps.append(delta)
        gradients.append(delta/max(length, 1e-12))
        ranked_edges.append((delta/max(length, 1e-12), delta, length, a, b))
        merged = Counter(weights[a]); merged.update(weights[b])
        dominant = merged.most_common(1)[0][0] if merged else 'unweighted'
        regional[dominant].append(delta/max(length, 1e-12))
    return {'adjacent_weight_l1_delta': distribution(jumps),
            'adjacent_weight_l1_delta_per_m': distribution(gradients),
            'gradient_per_m_by_dominant_bone': {n: distribution(v) for n, v in sorted(regional.items())},
            'largest_gradient_edges': [
                {'gradient_per_m': gradient, 'weight_l1_delta': delta, 'edge_length_m': length,
                 'vertex_indices': [a, b], 'bind_positions_gltf_y_up': [list(vertices[a]), list(vertices[b])],
                 'bind_positions_blender_z_up': [[vertices[i].x, -vertices[i].z, vertices[i].y] for i in (a, b)],
                 'weights': [weights[a], weights[b]]}
                for gradient, delta, length, a, b in sorted(ranked_edges, reverse=True)[:8]],
            'maximum_seam_weight_l1_disagreement': seam_disagreement,
            'interpretation': 'L1 weight change lies in 0..2; dividing by edge length measures the spatial attachment transition. These are diagnostics, not arbitrary universal pass thresholds.'}


def surface_report(vertices, triangles, intersections=True, vertex_groups=None):
    """Geometric topology remains valid despite glTF UV/normal seam duplication."""
    weld = {}
    ids = []
    welded = []
    for vertex in vertices:
        key = tuple(round(float(c), 6) for c in vertex)
        if key not in weld:
            weld[key] = len(weld)
            welded.append(vertex)
        ids.append(weld[key])
    tris = [tuple(ids[i] for i in t) for t in triangles]
    edges = defaultdict(list)
    neighbors = defaultdict(set)
    vertex_links = defaultdict(lambda: defaultdict(set))
    areas = []
    qualities = []
    triangle_volumes = []
    volume = 0.
    degenerate = []
    for index, (a, b, c) in enumerate(tris):
        va, vb, vc = (welded[i] for i in (a, b, c))
        area = (vb-va).cross(vc-va).length*.5
        areas.append(area)
        triangle_volume = va.dot(vb.cross(vc))/6
        volume += triangle_volume
        triangle_volumes.append(triangle_volume)
        edge_square_sum = (vb-va).length_squared+(vc-vb).length_squared+(va-vc).length_squared
        qualities.append(4*math.sqrt(3)*area/max(edge_square_sum, 1e-30))
        if len({a, b, c}) < 3 or area < 1e-12:
            degenerate.append(index)
        for u, v in ((a, b), (b, c), (c, a)):
            edges[min(u, v), max(u, v)].append(1 if u < v else -1)
            neighbors[u].add(v)
            neighbors[v].add(u)
        for center, u, v in ((a, b, c), (b, c, a), (c, a, b)):
            vertex_links[center][u].add(v)
            vertex_links[center][v].add(u)
    remaining = set(range(len(welded)))
    components = []
    component_ids = {}
    while remaining:
        todo = [remaining.pop()]
        count = 0
        while todo:
            u = todo.pop()
            component_ids[u] = len(components)
            count += 1
            fresh = neighbors[u] & remaining
            remaining.difference_update(fresh)
            todo.extend(fresh)
        components.append(count)
    component_volumes = [0.]*len(components)
    for tri, value in zip(tris, triangle_volumes):
        component_volumes[component_ids[tri[0]]] += value
    bad_vertices = []
    for vertex, link in vertex_links.items():
        todo = [next(iter(link))]
        seen = set(todo)
        while todo:
            fresh = link[todo.pop()] - seen
            seen.update(fresh)
            todo.extend(fresh)
        if len(seen) != len(link) or any(len(adjacent) != 2 for adjacent in link.values()):
            bad_vertices.append(vertex)
    pairs = []
    coplanar_pairs = set()
    if intersections:
        tree = BVHTree.FromPolygons(vertices, triangles, all_triangles=True, epsilon=0.)
        pairs = {(min(a, b), max(a, b)) for a, b in tree.overlap(tree)
                 if a != b and not set(tris[a]).intersection(tris[b])}
        coplanar_pairs = coplanar_overlaps(vertices, triangles, tris)
        pairs = sorted(pairs | coplanar_pairs)
    region_pairs = Counter()
    if vertex_groups is not None:
        def region(triangle_index):
            weights = Counter()
            for vertex_index in triangles[triangle_index]:
                weights.update(vertex_groups[vertex_index])
            return weights.most_common(1)[0][0] if weights else 'unweighted'
        for a, b in pairs:
            region_pairs[' / '.join(sorted((region(a), region(b))))] += 1
    return {
        'raw_vertices': len(vertices), 'welded_vertices': len(welded),
        'seam_duplicates': len(vertices)-len(welded), 'triangles': len(tris),
        'components': len(components), 'component_vertices': sorted(components, reverse=True),
        'component_signed_volumes_m3': component_volumes,
        'boundary_edges': sum(len(v) == 1 for v in edges.values()),
        'nonmanifold_edges': sum(len(v) != 2 for v in edges.values()),
        'nonmanifold_vertices': len(bad_vertices),
        'inconsistent_winding_edges': sum(len(v) == 2 and sum(v) != 0 for v in edges.values()),
        'euler_characteristic': len(welded)-len(edges)+len(tris),
        'signed_volume_m3': volume, 'minimum_triangle_area_m2': min(areas, default=0),
        'edge_length_m': distribution([(welded[a]-welded[b]).length for a, b in edges]),
        'triangle_area_m2': distribution(areas),
        'triangle_shape_quality': distribution(qualities),
        'degenerate_triangles': len(degenerate), 'degenerate_samples': degenerate[:10],
        'self_intersection_pairs': len(pairs) if intersections else None,
        'coplanar_overlap_pairs': len(coplanar_pairs) if intersections else None,
        'self_intersection_region_pairs': dict(region_pairs.most_common()),
        'self_intersection_samples': [
            {'triangles': [a, b], 'first_triangle_centroid': list(sum((vertices[k] for k in triangles[a]), Vector())/3)}
            for a, b in pairs[:12]],
    }


def audit_export(glb, report, check):
    doc = glb.doc
    nodes = doc['nodes']
    skin = doc.get('skins', [])
    check(len(skin) == 1, f'Expected one skin, found {len(skin)}')
    mesh_nodes = [(i, node) for i, node in enumerate(nodes) if 'mesh' in node]
    names = [node.get('name') for _, node in mesh_nodes]
    check(set(names) == MESH_NAMES and len(names) == 5, f'Expected five exact mesh nodes; got {names}')
    check(all(node.get('skin') == 0 for _, node in mesh_nodes), 'All five mesh objects must use skin 0')
    check(not doc.get('animations'), 'Unexpected animation clips present')
    joints = skin[0]['joints'] if skin else []
    bone_nodes = {nodes[i].get('name'): i for i in joints}
    required = {'root'} | set(PARENTS)
    check(required <= set(bone_nodes), f'Missing required bones: {sorted(required-set(bone_nodes))}')
    check(set(bone_nodes) <= required | set(OPTIONAL_PARENTS), f'Unexpected bone names: {sorted(set(bone_nodes)-required-set(OPTIONAL_PARENTS))}')
    check(len(bone_nodes) == len(joints), 'Duplicate bone names')
    for child, parent in {**PARENTS, **OPTIONAL_PARENTS}.items():
        if child not in bone_nodes:
            continue
        got = nodes[glb.parent[bone_nodes[child]]].get('name') if bone_nodes[child] in glb.parent else None
        check(got == parent, f'{child} parent is {got!r}, expected {parent!r}')
    bone_positions = {name: glb.world(i).translation for name, i in bone_nodes.items()}
    if 'root' in bone_positions:
        check(bone_positions['root'].length < 1e-5, 'root must be at the world floor origin')
    mirror_errors = {}
    for name, position in bone_positions.items():
        if name.endswith('_L') and name[:-2]+'_R' in bone_positions:
            opposite = bone_positions[name[:-2]+'_R']
            error = (position-Vector((-opposite.x, opposite.y, opposite.z))).length
            mirror_errors[name[:-2]] = error
            check(position.x > 0 and opposite.x < 0, f'{name} side convention is wrong')
            check(error < 1e-5, f'{name} and its counterpart differ under X reflection by {error:g} m')
            left_basis = glb.world(bone_nodes[name]).to_3x3()
            right_basis = glb.world(bone_nodes[name[:-2]+'_R']).to_3x3()
            for axis in range(3):
                mirrored = Vector((-right_basis.col[axis].x, right_basis.col[axis].y, right_basis.col[axis].z)).normalized()
                # Reflecting a frame reverses handedness; flip local X to
                # retain right-handed bone frames with mirrored Y and Z axes.
                if axis == 0:
                    mirrored.negate()
                check((left_basis.col[axis].normalized()-mirrored).length < 1e-4,
                      f'{name} local axis {axis} does not mirror its counterpart (bone roll mismatch)')
    report['skeleton'] = {'skin_count': len(skin), 'bones': sorted(bone_nodes),
                          'world_joint_positions': {n: list(v) for n, v in bone_positions.items()},
                          'mirror_position_error_m': mirror_errors}
    if skin and 'inverseBindMatrices' in skin[0]:
        inverse_binds = glb.accessor(skin[0]['inverseBindMatrices'])
        check(len(inverse_binds) == len(joints), 'Inverse bind matrix count differs from joints')
        errors = []
        for joint, flat in zip(joints, inverse_binds):
            ibm = Matrix([flat[i:i+4] for i in range(0, 16, 4)]).transposed()
            m = glb.world(joint) @ ibm
            errors.append(max(abs(m[r][c]-(1 if r == c else 0)) for r in range(4) for c in range(4)))
        report['skeleton']['maximum_bind_identity_error'] = max(errors, default=0)
        check(max(errors, default=0) < 1e-4, 'Joint world matrix times inverse bind is not identity')
    meshes = {}
    all_vertices = []
    for node_index, node in mesh_nodes:
        name = node.get('name')
        mesh = doc['meshes'][node['mesh']]
        check(mesh.get('name') == name, f'Mesh resource and node name differ for {name}')
        morphs = mesh.get('extras', {}).get('targetNames', [])
        check(set(morphs) <= MORPH_NAMES, f'{name} has unsupported morph targets: {morphs}')
        mesh_defaults = mesh.get('weights', [0.]*len(morphs))
        node_defaults = node.get('weights', mesh_defaults)
        check(len(mesh_defaults) == len(morphs), f'{name} default mesh morph weight count differs from target count')
        check(len(node_defaults) == len(morphs), f'{name} default node morph weight count differs from target count')
        check(all(math.isfinite(w) and abs(w) < 1e-7 for w in mesh_defaults),
              f'{name} mesh.weights must all default to zero; got {mesh_defaults}')
        check(all(math.isfinite(w) and abs(w) < 1e-7 for w in node_defaults),
              f'{name} node.weights must all default to zero; got {node_defaults}')
        positions, triangles, states = [], [], {key: [] for key in morphs}
        skin_weights = []
        softness = []
        normal_lengths = []
        maximum_weight_error = 0.
        maximum_influences = 0
        invalid_joint_indices = 0
        negative_weights = 0
        bone_weight_sums = Counter()
        for primitive in mesh['primitives']:
            check(primitive.get('mode', 4) == 4, f'{name} is not triangulated')
            attrs = primitive['attributes']
            check(all(k in attrs for k in ('POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0')), f'{name} misses required vertex attributes')
            local_positions = [Vector(v) for v in glb.accessor(attrs['POSITION'])]
            world = glb.world(node_index)
            base = len(positions)
            positions.extend(world @ v for v in local_positions)
            raw_indices = [r[0] for r in glb.accessor(primitive['indices'])] if 'indices' in primitive else list(range(len(local_positions)))
            check(len(raw_indices) % 3 == 0, f'{name} has non-triangle index count')
            check(all(0 <= i < len(local_positions) for i in raw_indices), f'{name} has out-of-bounds vertex indices')
            triangles.extend(tuple(i+base for i in raw_indices[k:k+3]) for k in range(0, len(raw_indices), 3))
            normal_lengths.extend(Vector(n).length for n in glb.accessor(attrs['NORMAL']))
            joint_sets = [glb.accessor(attrs[f'JOINTS_{k}']) for k in range(4) if f'JOINTS_{k}' in attrs]
            weight_sets = [glb.accessor(attrs[f'WEIGHTS_{k}']) for k in range(4) if f'WEIGHTS_{k}' in attrs]
            for vertex in range(len(local_positions)):
                influences = [(int(j), w) for js, ws in zip(joint_sets, weight_sets) for j, w in zip(js[vertex], ws[vertex])]
                maximum_weight_error = max(maximum_weight_error, abs(sum(w for _, w in influences)-1))
                maximum_influences = max(maximum_influences, sum(w > 1e-6 for _, w in influences))
                vertex_weights = Counter()
                for joint, weight in influences:
                    invalid_joint_indices += not 0 <= joint < len(joints)
                    negative_weights += weight < 0
                    if 0 <= joint < len(joints):
                        bone_weight_sums[nodes[joints[joint]]['name']] += weight
                        if weight > 0:
                            vertex_weights[nodes[joints[joint]]['name']] += weight
                skin_weights.append(dict(vertex_weights))
            targets = primitive.get('targets', [])
            check(len(targets) == len(morphs), f'{name} morph labels/count mismatch')
            for key, target in zip(morphs, targets):
                deltas = glb.accessor(target['POSITION']) if 'POSITION' in target else [(0, 0, 0)]*len(local_positions)
                states[key].extend(world @ (p+Vector(d)) for p, d in zip(local_positions, deltas))
            if name in FLESH_NAMES:
                # glTF custom semantics are uppercased by the Blender exporter;
                # GLTFLoader lowercases them back to geometry attribute _softness.
                softness_key = next((k for k in attrs if k.lower() == '_softness'), None)
                check(softness_key is not None, f'{name} is missing custom _softness attribute')
                if softness_key:
                    a = doc['accessors'][attrs[softness_key]]
                    check(a['componentType'] == 5126 and a['type'] == 'SCALAR', f'{name} _softness is not float scalar')
                    softness.extend(v[0] for v in glb.accessor(attrs[softness_key]))
                    report.setdefault('softness_export_semantics', {})[name] = softness_key
        check(all(math.isfinite(c) for v in positions for c in v), f'{name} contains nonfinite positions')
        check(maximum_weight_error < 1e-5, f'{name} weights do not sum to 1: max error {maximum_weight_error:g}')
        check(maximum_influences <= 4, f'{name} exceeds four exported skin influences')
        check(invalid_joint_indices == 0 and negative_weights == 0, f'{name} has invalid skin data')
        check(all(abs(n-1) < 1e-4 for n in normal_lengths), f'{name} has nonunit normals')
        mr = {'vertices': len(positions), 'triangles': len(triangles), 'morph_targets': morphs,
              'default_mesh_morph_weights': mesh_defaults, 'effective_default_node_morph_weights': node_defaults,
              'maximum_weight_sum_error': maximum_weight_error, 'maximum_skin_influences': maximum_influences,
              'mean_bone_weights': {n: s/len(positions) for n, s in bone_weight_sums.items() if s > 0},
              'bounds': [[min(v[k] for v in positions) for k in range(3)], [max(v[k] for v in positions) for k in range(3)]]}
        if name in FLESH_NAMES:
            if name == 'Body':
                check(3000 <= len(triangles) <= 12000, f'Body triangle count outside 3k-12k: {len(triangles)}')
            mr['skin_weight_continuity'] = skin_weight_report(positions, triangles, skin_weights)
            check(mr['skin_weight_continuity']['maximum_seam_weight_l1_disagreement'] < 1e-5,
                  f'{name} has inconsistent skin weights across exported geometric seams')
            mr['states'] = {}
            for state, vertices in {'Basis': positions, **states}.items():
                sr = surface_report(vertices, triangles)
                mr['states'][state] = sr
                for metric in ('nonmanifold_edges', 'nonmanifold_vertices', 'inconsistent_winding_edges', 'degenerate_triangles', 'self_intersection_pairs'):
                    check(sr[metric] == 0, f'{name} {state}: {metric}={sr[metric]}')
                check(sr['components'] == EXPECTED_COMPONENTS[name], f'{name} {state} has {sr["components"]} connected components; expected {EXPECTED_COMPONENTS[name]}')
                check(all(v > 0 for v in sr['component_signed_volumes_m3']), f'{name} {state} has inward component winding')
            mr['intermediate_morph_states'] = {}
            for state, target_positions in states.items():
                for factor in INTERMEDIATE_FACTORS:
                    label = f'{state}@{factor:g}'
                    vertices = [a.lerp(b, factor) for a, b in zip(positions, target_positions)]
                    sr = surface_report(vertices, triangles)
                    mr['intermediate_morph_states'][label] = sr
                    for metric in ('nonmanifold_edges', 'nonmanifold_vertices', 'inconsistent_winding_edges', 'degenerate_triangles', 'self_intersection_pairs'):
                        check(sr[metric] == 0, f'{name} morph {label}: {metric}={sr[metric]}')
                    check(sr['components'] == EXPECTED_COMPONENTS[name] and all(v > 0 for v in sr['component_signed_volumes_m3']),
                          f'{name} morph {label}: surface collapsed or split')
            report['intermediate_morph_sample_count'] = report.get('intermediate_morph_sample_count', 0)+len(mr['intermediate_morph_states'])
            if softness:
                mr['softness_range'] = [min(softness), max(softness)]
                check(len(softness) == len(positions), f'{name} _softness count does not match positions')
                check(min(softness) >= 0 and max(softness) <= 1, f'{name} _softness outside 0..1')
                if name == 'Body':
                    belly = [s for v, s in zip(positions, softness) if abs(v.x) < .10 and .40 < v.y < .58 and v.z > .15]
                    back = [s for v, s in zip(positions, softness) if .40 < v.y < .70 and v.z < -.10]
                    mr['mean_belly_softness'] = sum(belly)/len(belly) if belly else None
                    mr['mean_back_softness'] = sum(back)/len(back) if back else None
                    check(bool(belly) and sum(belly)/len(belly) > .85, 'Central belly _softness is not near 1')
                    check(bool(back) and .1 <= sum(back)/len(back) <= .3, 'Back _softness is not near .2')
                else:
                    proximal = ('upperarm_',) if name == 'Arms' else ('thigh_',)
                    firm = ('hand_', 'thumb_', 'index_', 'middle_', 'ring_') if name == 'Arms' else ('foot_',)
                    for label, prefixes in [('proximal', proximal), ('hands_or_feet', firm)]:
                        samples = [s for w, s in zip(skin_weights, softness) if sum(v for n, v in w.items() if n.startswith(prefixes)) > .7]
                        mr.setdefault('regional_softness', {})[label] = distribution(samples)
                        if samples:
                            average = sum(samples)/len(samples)
                            check(.30 <= average <= .70 if label == 'proximal' else .05 <= average <= .30,
                                  f'{name} {label} softness differs substantially from contract: {average:g}')
        meshes[name] = mr
        all_vertices.extend(positions)
    report['meshes'] = meshes
    total = sum(v['triangles'] for v in meshes.values())
    report['total_triangles'] = total
    check(total <= 40000, f'Total triangle budget exceeded: {total}')
    if all_vertices:
        low = [min(v[k] for v in all_vertices) for k in range(3)]
        high = [max(v[k] for v in all_vertices) for k in range(3)]
        report['world_bounds_m'] = [low, high]
        check(.95 < high[1]-low[1] < 1.05, f'Height is not about 1 metre: {high[1]-low[1]:g}')
        check(abs(low[1]) < .006, f'Soles are not at y=0: {low[1]:g}')
        check(abs(low[0]+high[0]) < .005, 'Model X bounds are not centred')
    if 'Eyes' in meshes and 'Body' in meshes:
        check(sum(meshes['Eyes']['bounds'][k][2] for k in (0, 1)) > 0, 'Eye landmark does not face +Z')
    report['embedded_images'] = [{'name': image.get('name'), 'mimeType': image.get('mimeType'), 'embedded': 'bufferView' in image} for image in doc.get('images', [])]


def audit_authoring_and_stress(blend_path, builder_path, report, check, endpoints_only=False):
    bpy.ops.wm.open_mainfile(filepath=str(blend_path))
    rig = bpy.data.objects['NaiwaRig']
    objects = [bpy.data.objects[name] for name in sorted(MESH_NAMES)]
    body = bpy.data.objects['Body']
    report['authoring_default_morph_values'] = {
        ob.name: {key.name: key.value for key in ob.data.shape_keys.key_blocks}
        for ob in objects if ob.data.shape_keys}
    for name, keys in report['authoring_default_morph_values'].items():
        check(all(math.isfinite(value) and abs(value) < 1e-7 for value in keys.values()),
              f'Authoring {name} saved shape key values must all be zero; got {keys}')
    report['authoring_flesh'] = {}
    for name in sorted(FLESH_NAMES):
        ob = bpy.data.objects[name]
        ob.data.calc_loop_triangles()
        triangles = [tuple(t.vertices) for t in ob.data.loop_triangles]
        source = surface_report([v.co.copy() for v in ob.data.vertices], triangles)
        report['authoring_flesh'][name] = source
        check(source['raw_vertices'] == source['welded_vertices'], f'Authoring {name} contains duplicated geometric vertices')
        check(source['nonmanifold_edges'] == 0 and source['nonmanifold_vertices'] == 0 and
              source['components'] == EXPECTED_COMPONENTS[name], f'Authoring {name} is not the expected closed manifold shells')
        check(all(v > 0 for v in source['component_signed_volumes_m3']), f'Authoring {name} has inward component winding')
    report['authoring_body'] = report['authoring_flesh']['Body']
    tree = ast.parse(builder_path.read_text())
    function_names = {'clamp', 'smooth', 'profile', 'front_y', 'body_weights',
                      'reset', 'expression', 'aim_bone', 'skin_point', 'solve_arm', 'solve_leg', 'pose'}
    kept = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in function_names]
    assignments = [node for node in tree.body if isinstance(node, ast.Assign) and
                   any(isinstance(t, ast.Name) and t.id in {'PROFILE', 'STATES', 'PI'} for t in node.targets)]
    context = {'bpy': bpy, 'math': math, 'Vector': Vector, 'Matrix': Matrix,
               'Quaternion': Quaternion, 'rig': rig, 'objects': objects, 'bodyob': body}
    exec(compile(ast.Module(body=assignments+kept, type_ignores=[]), str(builder_path), 'exec'), context)
    modifiers = [(ob.name, modifier, modifier.use_deform_preserve_volume) for ob in objects
                 for modifier in ob.modifiers if modifier.type == 'ARMATURE']
    report['authoring_default_preserve_volume'] = {name: flag for name, _, flag in modifiers}
    report['skinning_modes'] = {}
    report['skinning_mode_note'] = 'LBS is the ordinary glTF skin behavior. DQ is Blender armature preserve-volume evaluation; glTF does not encode DQ, so the application must supply that target implementation.'

    def evaluate_state(label, mode_failures, rest_volumes):
        graph = bpy.context.evaluated_depsgraph_get()
        entries = {}
        for name in ('Body', 'Arms', 'Legs'):
            ob = bpy.data.objects[name]
            evaluated = ob.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            mesh.calc_loop_triangles()
            triangles = [tuple(t.vertices) for t in mesh.loop_triangles]
            vertices = [evaluated.matrix_world @ v.co for v in mesh.vertices]
            vertex_groups = [{ob.vertex_groups[g.group].name: g.weight for g in v.groups} for v in mesh.vertices]
            sr = surface_report(vertices, triangles, vertex_groups=vertex_groups)
            entries[name] = sr
            if name in rest_volumes:
                sr['signed_volume_ratio_to_rest'] = sr['signed_volume_m3']/rest_volumes[name]
            for metric in ('nonmanifold_edges', 'nonmanifold_vertices', 'inconsistent_winding_edges', 'degenerate_triangles', 'self_intersection_pairs'):
                if sr[metric] != 0:
                    mode_failures.append(f'{label} {name}: {metric}={sr[metric]}')
            if sr['components'] != EXPECTED_COMPONENTS[name] or not all(v > 0 for v in sr['component_signed_volumes_m3']):
                mode_failures.append(f'{label} {name}: components or signed volumes invalid')
            evaluated.to_mesh_clear()
        return entries

    pose_names = ('rest', 'holding', 'laugh', 'peace', 'deep_bend', 'arms_up', 'belly_cross', 'squat', 'leg_lift', 'hop', 'twist')
    for mode in ('LBS', 'DQ'):
        for _, modifier, _ in modifiers:
            modifier.use_deform_preserve_volume = mode == 'DQ'
        mode_report = {'stress_poses': {}, 'intermediate_poses': {}, 'failures': []}
        rest_volumes = {}
        for pose_name in pose_names:
            context['pose'](pose_name)
            if pose_name != 'rest':
                check(any(pb.location.length > 1e-6 or abs(pb.rotation_quaternion.angle) > 1e-5 for pb in rig.pose.bones),
                      f'Pose {pose_name} did not move any bones')
            entries = evaluate_state(pose_name, mode_report['failures'], rest_volumes)
            mode_report['stress_poses'][pose_name] = entries
            if pose_name == 'rest':
                rest_volumes = {name: sr['signed_volume_m3'] for name, sr in entries.items()}
            print('POSE CHECK', mode, pose_name,
                  {n: {'intersections': r['self_intersection_pairs'], 'degenerate': r['degenerate_triangles']} for n, r in entries.items()}, flush=True)
            if pose_name == 'rest' or endpoints_only:
                continue
            target_bones = {pb.name: (pb.location.copy(), pb.rotation_quaternion.copy(), pb.scale.copy()) for pb in rig.pose.bones}
            target_shapes = {(ob.name, key.name): key.value for ob in objects if ob.data.shape_keys
                             for key in ob.data.shape_keys.key_blocks if key.name != 'Basis'}
            for factor in INTERMEDIATE_FACTORS:
                context['reset']()
                for name, (location, rotation, scale) in target_bones.items():
                    pb = rig.pose.bones[name]
                    pb.location = location*factor
                    pb.rotation_quaternion = Quaternion().slerp(rotation, factor)
                    pb.scale = Vector((1, 1, 1)).lerp(scale, factor)
                for (name, shape_name), value in target_shapes.items():
                    bpy.data.objects[name].data.shape_keys.key_blocks[shape_name].value = value*factor
                bpy.context.view_layer.update()
                label = f'{pose_name}@{factor:g}'
                samples = evaluate_state(label, mode_report['failures'], rest_volumes)
                mode_report['intermediate_poses'][label] = samples
                findings = {name: metrics['self_intersection_pairs'] for name, metrics in samples.items()
                            if metrics['self_intersection_pairs'] or metrics['degenerate_triangles']}
                if findings:
                    print('INTERMEDIATE FINDING', mode, label, findings, flush=True)
            print('INTERMEDIATE CHECK', mode, pose_name, '3 quaternion-slerp samples', flush=True)
        mode_report['passed'] = not mode_report['failures']
        mode_report['overlap_findings'] = [
            {'pose': pose_name, 'mesh': name, 'pairs': metrics['self_intersection_pairs'],
             'regions': metrics['self_intersection_region_pairs']}
            for pose_name, meshes in {**mode_report['stress_poses'], **mode_report['intermediate_poses']}.items()
            for name, metrics in meshes.items() if metrics['self_intersection_pairs']]
        mode_report['endpoint_pose_sample_count'] = len(mode_report['stress_poses'])
        mode_report['intermediate_pose_sample_count'] = len(mode_report['intermediate_poses'])
        mode_report['posed_mesh_sample_count'] = 3*(len(mode_report['stress_poses'])+len(mode_report['intermediate_poses']))
        report['skinning_modes'][mode] = mode_report
        report[mode.lower()+'_passed'] = mode_report['passed']
    context['reset']()
    for _, modifier, original in modifiers:
        modifier.use_deform_preserve_volume = original
    selected = report['skinning_modes']['DQ']
    report['stress_surfaces_clear'] = selected['passed']
    report['limb_overlap_findings'] = [entry for entry in selected['overlap_findings'] if entry['mesh'] != 'Body']
    report['endpoint_pose_sample_count'] = selected['endpoint_pose_sample_count']
    report['intermediate_pose_sample_count'] = selected['intermediate_pose_sample_count']
    report['posed_mesh_sample_count'] = sum(mode['posed_mesh_sample_count'] for mode in report['skinning_modes'].values())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--glb', type=Path, default=ROOT/'public/models/naiwa.glb')
    parser.add_argument('--report', type=Path, default=HERE/'independent-validation.json')
    parser.add_argument('--stress', action='store_true')
    parser.add_argument('--endpoints-only', action='store_true', help='Quick DQ/LBS diagnostic without pose interpolation samples')
    parser.add_argument('--blend', type=Path, default=HERE/'naiwa.blend')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    failures = []
    def check(ok, message):
        if not ok:
            failures.append(message)
            print('FAIL:', message, flush=True)
    report = {'validator': 'independent GLB and Blender surface audit',
              'blender_version': bpy.app.version_string,
              'glb_sha256': hashlib.sha256(args.glb.read_bytes()).hexdigest(),
              'glb_bytes': args.glb.stat().st_size,
              'method': {'topology_weld_precision_m': 1e-6,
                         'intersection_test': 'Blender triangle BVHTree plus coplanar plane-bin / 2D separating-axis test, excluding shared geometric vertex pairs',
                         'intermediate_sampling': 'Body morph weights .25/.5/.75; local bone quaternion slerps from rest to each named pose at .25/.5/.75, with linear local translation, scale, and morph weights.',
                         'limitations': 'Discrete endpoint and intermediate samples; no continuous collision detection; incident triangle overlaps are excluded; visual deformation and reference likeness require rendered review.'}}
    audit_export(GLB(args.glb), report, check)
    if args.stress:
        builder_path = HERE/'build_naiwa.py'
        report['blend_sha256'] = hashlib.sha256(args.blend.read_bytes()).hexdigest()
        report['builder_sha256'] = hashlib.sha256(builder_path.read_bytes()).hexdigest()
        audit_authoring_and_stress(args.blend, builder_path, report, check, endpoints_only=args.endpoints_only)
    # Reject reports whose inputs changed while another agent/export was running.
    check(report['glb_sha256'] == hashlib.sha256(args.glb.read_bytes()).hexdigest(), 'GLB changed during validation')
    if args.stress:
        check(report['blend_sha256'] == hashlib.sha256(args.blend.read_bytes()).hexdigest(), 'Blend changed during validation')
        check(report['builder_sha256'] == hashlib.sha256(builder_path.read_bytes()).hexdigest(), 'Builder changed during validation')
    report['passed'] = not failures and report.get('dq_passed', True)
    report['contract_passed'] = not failures
    report['failures'] = failures
    args.report.write_text(json.dumps(report, indent=2)+'\n')
    print('NAIWA INDEPENDENT VALIDATION', 'PASS' if report['passed'] else 'FAIL',
          f'{len(failures)} contract failures; DQ={report.get("dq_passed")}, LBS={report.get("lbs_passed")}; {report["total_triangles"]} triangles;', args.report, flush=True)
    if not report['passed']:
        sys.exit(1)


if __name__ == '__main__':
    main()
