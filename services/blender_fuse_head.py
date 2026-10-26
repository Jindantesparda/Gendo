"""Fuse a DECA face sequence onto a GVHMR rigged body.

Inputs
------
* A rigged body FBX produced by tools/demo/blender_build_rig.py
* deca_face.npz from Gendo's deca_face_worker.py
* The DECA UV texture

Outputs
-------
* A combined rigged FBX: GVHMR skeleton + body (head removed) + skinned DECA
  head + per-frame facial shape-key animation
* A .blend scene containing the same setup with the texture packed
* A preview image (Workbench) for quick inspection

The DECA head is placed by mapping its FLAME head joint onto the GVHMR SMPL-X
head bone. Its FLAME neck weights are mapped to the GVHMR neck bone, so neck
bending deforms the base of the head naturally. DECA's global head rotation is
already stripped by the worker; all head/neck motion comes from GVHMR.
"""
import argparse
import os
import shutil
import sys
import traceback

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--body-rig", required=True)
    parser.add_argument("--head-data", required=True)
    parser.add_argument("--texture", required=True)
    parser.add_argument("--out-fbx", required=True)
    parser.add_argument("--out-blend", required=True)
    parser.add_argument("--preview", default=None)
    parser.add_argument("--sync", choices=["fit", "offset"], default="fit")
    parser.add_argument("--face-offset", type=int, default=0)
    parser.add_argument("--head-scale", type=float, default=1.0)
    parser.add_argument("--head-offset-x", type=float, default=0.0)
    parser.add_argument("--head-offset-y", type=float, default=0.0)
    parser.add_argument("--head-offset-z", type=float, default=0.0)
    parser.add_argument("--delete-threshold", type=float, default=0.5)
    parser.add_argument("--keep-body-material", action="store_true")
    return parser.parse_args(argv)


def ensure_dir(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)


def find_armature():
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if not armatures:
        raise RuntimeError("The body FBX contains no armature.")
    # Prefer the object the rigged exporter names SMPLX_Rig.
    for obj in armatures:
        if "SMPLX_Rig" in obj.name or "SMPLX" in obj.name:
            return obj
    return armatures[0]


def find_body(arm):
    candidates = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    for obj in candidates:
        if obj.name.startswith("SMPLX_Body"):
            return obj
    for obj in candidates:
        if any(group.name in {"head", "jaw", "neck"} for group in obj.vertex_groups):
            return obj
    if not candidates:
        raise RuntimeError("The body FBX contains no mesh.")
    return candidates[0]


def group_index(obj, name):
    group = obj.vertex_groups.get(name)
    return group.index if group else None


def delete_head_region(body, arm, threshold):
    head_idx = group_index(body, "head")
    jaw_idx = group_index(body, "jaw")
    if head_idx is None and jaw_idx is None:
        raise RuntimeError("Body mesh has no 'head' or 'jaw' vertex groups.")
    group_ids = {idx for idx in (head_idx, jaw_idx) if idx is not None}
    remove = set()
    for vert in body.data.vertices:
        weight = 0.0
        for assignment in vert.groups:
            if assignment.group in group_ids:
                weight += assignment.weight
        if weight >= threshold:
            remove.add(vert.index)
    if not remove:
        raise RuntimeError("No body head vertices matched the removal threshold.")
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in remove], context="VERTS")
    bm.to_mesh(body.data)
    bm.free()
    body.data.update()
    print(f"Removed {len(remove)} SMPL-X head vertices from the body mesh.", flush=True)
    return len(remove)


def action_range(arm):
    action = arm.animation_data.action if arm.animation_data else None
    if action is None:
        actions = [act for act in bpy.data.actions if act.fcurves or getattr(act, "layers", None)]
        action = actions[0] if actions else None
    if action is None:
        raise RuntimeError("The imported body rig has no animation action.")
    start, end = action.frame_range
    return int(round(start)), int(round(end)), action


def iter_fcurves(action):
    if hasattr(action, "fcurves"):
        yield from action.fcurves
        return
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", []):
                yield from bag.fcurves


def make_material(name, base_color, texture_path=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (*base_color, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.72
    specular = bsdf.inputs.get("Specular IOR Level")
    if specular is not None:
        specular.default_value = 0.22
    if texture_path:
        image = bpy.data.images.load(texture_path, check_existing=True)
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.interpolation = "Linear"
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        mat.diffuse_color = (0.8, 0.7, 0.6, 1.0)
    else:
        mat.diffuse_color = (*base_color, 1.0)
    return mat


def build_head_mesh(args, head_data, target_head, arm, head_bone, neck_bone):
    base = head_data["base_vertices"].astype(np.float64)
    frames = head_data["frame_vertices"].astype(np.float64)
    faces = head_data["faces"].astype(np.int64)
    uv_coords = head_data["uv_coords"].astype(np.float64)
    uv_faces = head_data["uv_faces"].astype(np.int64)
    weights = head_data["weights"].astype(np.float64)
    joints = head_data["joints"].astype(np.float64)

    source_head = joints[1]
    scale = float(args.head_scale)
    offset = np.array([args.head_offset_x, args.head_offset_y, args.head_offset_z], dtype=np.float64)

    def place(vertices):
        return (vertices - source_head[None, :]) * scale + target_head[None, :] + offset[None, :]

    base_placed = place(base)
    frames_placed = place(frames)
    print(
        f"Head alignment: FLAME head joint {source_head.round(4).tolist()} -> "
        f"SMPL-X head joint {target_head.round(4).tolist()}  scale={scale:.3f}",
        flush=True,
    )

    mesh = bpy.data.meshes.new("DECA_Head")
    mesh.from_pydata(base_placed.tolist(), [], faces.tolist())
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    mesh.update()

    uv_layer = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        uv_face = uv_faces[poly.index]
        if poly.loop_total != len(uv_face):
            raise RuntimeError("UV face size does not match mesh face size.")
        for j, loop_index in enumerate(range(poly.loop_start, poly.loop_start + poly.loop_total)):
            uv = uv_coords[uv_face[j]]
            # DECA's texture and UV atlas are authored top-down; this matches
            # Blender's image lookup for the FLAME mesh.
            uv_layer.data[loop_index].uv = (float(uv[0]), float(uv[1]))

    head = bpy.data.objects.new("DECA_Head", mesh)
    bpy.context.scene.collection.objects.link(head)
    head.matrix_world = arm.matrix_world.copy()

    head_group = head.vertex_groups.new(name=head_bone.name)
    neck_group = head.vertex_groups.new(name=neck_bone.name)
    neck_weights = np.clip(weights[:, 0], 0.0, 1.0)
    for index, neck_weight in enumerate(neck_weights.tolist()):
        head_group.add([index], float(1.0 - neck_weight), "REPLACE")
        if neck_weight > 1e-5:
            neck_group.add([index], float(neck_weight), "REPLACE")

    modifier = head.modifiers.new("Armature", "ARMATURE")
    modifier.object = arm

    basis = head.shape_key_add(name="Basis", from_mix=False)
    basis.value = 0.0
    head.data.shape_keys.use_relative = True
    key_blocks = []
    for frame_index in range(int(head_data["frame_count"])):
        key = head.shape_key_add(name=f"Face_{frame_index:04d}", from_mix=False)
        key.data.foreach_set("co", frames_placed[frame_index].reshape(-1).tolist())
        key.value = 0.0
        key_blocks.append(key)

    tex_path = args.texture
    head.data.materials.append(make_material("DECA_Head_Skin", (0.75, 0.58, 0.48), tex_path))
    return head, key_blocks, int(head_data["frame_count"])


def animate_face(head, key_blocks, body_start, body_end, args):
    face_count = len(key_blocks)
    if face_count == 0:
        raise RuntimeError("DECA head data has no frames.")
    scene = bpy.context.scene

    def face_index_for(frame):
        if args.sync == "offset":
            return max(0, min(face_count - 1, int(round(frame - body_start + args.face_offset))))
        if body_end == body_start:
            return 0
        ratio = (frame - body_start) / float(body_end - body_start)
        return max(0, min(face_count - 1, int(round(ratio * (face_count - 1)))))

    # Every key needs an explicit zero at the first frame. Without this,
    # Blender extrapolates a key's first non-zero value backwards and several
    # face shapes are active at once, which collapses the head.
    for key in key_blocks:
        key.value = 0.0
        key.keyframe_insert("value", frame=body_start)

    previous = face_index_for(body_start)
    key_blocks[previous].value = 1.0
    key_blocks[previous].keyframe_insert("value", frame=body_start)

    for frame in range(body_start + 1, body_end + 1):
        index = face_index_for(frame)
        if previous != index:
            key_blocks[previous].value = 0.0
            key_blocks[previous].keyframe_insert("value", frame=frame)
            key_blocks[index].value = 1.0
            key_blocks[index].keyframe_insert("value", frame=frame)
            previous = index

    shape_keys = head.data.shape_keys
    if shape_keys.animation_data and shape_keys.animation_data.action:
        for fcurve in iter_fcurves(shape_keys.animation_data.action):
            for point in fcurve.keyframe_points:
                point.interpolation = "CONSTANT"
    scene.frame_start = body_start
    scene.frame_end = body_end
    print(
        f"Facial animation: {face_count} shape keys mapped over body frames "
        f"{body_start}-{body_end} using '{args.sync}' sync.",
        flush=True,
    )


def add_preview_render(args, arm, body, head):
    if not args.preview:
        return
    try:
        scene = bpy.context.scene
        scene.render.engine = "BLENDER_EEVEE"
        try:
            scene.eevee.taa_render_samples = 32
        except Exception:
            pass
        scene.render.resolution_x = 720
        scene.render.resolution_y = 720
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = args.preview
        scene.render.film_transparent = False
        if scene.world is None:
            scene.world = bpy.data.worlds.new("Fusion_World")
        scene.world.use_nodes = True
        background = scene.world.node_tree.nodes.get("Background")
        if background:
            background.inputs["Color"].default_value = (0.012, 0.014, 0.017, 1.0)
            background.inputs["Strength"].default_value = 0.35

        scene.frame_set(scene.frame_start)
        bpy.context.view_layer.update()
        points = []
        for obj in (body, head):
            points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
        mn = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
        mx = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
        center = (mn + mx) * 0.5
        height = max(mx.y - mn.y, 0.5)

        # The rigged body is Y-up in the FBX. Blender is Z-up, so construct the
        # camera basis explicitly instead of relying on Blender's global up.
        # Use the posed head bone's deformation of local +Z as the face view
        # direction; the character's root orientation can be turned sideways.
        pose_bone = arm.pose.bones.get("head")
        rest_bone = arm.data.bones.get("head")
        if pose_bone is not None and rest_bone is not None:
            deform = pose_bone.matrix @ rest_bone.matrix_local.inverted()
            front = (arm.matrix_world.to_3x3() @ deform.to_3x3() @ Vector((0.0, 0.0, 1.0))).normalized()
        else:
            front = (arm.matrix_world.to_3x3() @ Vector((0.0, 0.0, 1.0))).normalized()
        up_hint = Vector((0.0, 1.0, 0.0))
        right = front.cross(up_hint).normalized()
        cam_loc = center + front * (height * 1.65) + right * (height * 0.12)
        cam_loc.y = max(cam_loc.y, height * 0.58)
        bpy.ops.object.camera_add(location=cam_loc)
        cam = bpy.context.object
        cam.name = "Fusion_Preview_Camera"
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = height * 1.25
        target = center
        forward = (target - cam.location).normalized()
        x_axis = forward.cross(up_hint).normalized()
        z_axis = -forward
        y_axis = z_axis.cross(x_axis).normalized()
        cam.matrix_world = Matrix.Translation(cam_loc) @ Matrix((x_axis, y_axis, z_axis)).transposed().to_4x4()
        scene.camera = cam

        for name, power, offset in (
            ("Fusion_Key", 650.0, front * (height * 1.2) + right * (height * 0.7) + Vector((0, height * 0.35, 0))),
            ("Fusion_Fill", 240.0, front * (height * 1.4) - right * (height * 0.9) + Vector((0, height * 0.1, 0))),
        ):
            light_data = bpy.data.lights.new(name, "AREA")
            light_data.energy = power
            light_data.shape = "DISK"
            light_data.size = max(height * 0.7, 0.5)
            light = bpy.data.objects.new(name, light_data)
            bpy.context.scene.collection.objects.link(light)
            light.location = center + offset
            light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()

        scene.frame_set(scene.frame_start)
        bpy.ops.render.render(write_still=True)
        print(f"Preview rendered to {args.preview}", flush=True)

        # Close-up of the head for checking facial texture and the neck join.
        depsgraph = bpy.context.evaluated_depsgraph_get()
        evaluated = head.evaluated_get(depsgraph)
        evaluated_mesh = evaluated.to_mesh()
        world_points = [head.matrix_world @ v.co for v in evaluated_mesh.vertices]
        evaluated.to_mesh_clear()
        hmn = Vector((
            min(p.x for p in world_points),
            min(p.y for p in world_points),
            min(p.z for p in world_points),
        ))
        hmx = Vector((
            max(p.x for p in world_points),
            max(p.y for p in world_points),
            max(p.z for p in world_points),
        ))
        head_center = (hmn + hmx) * 0.5
        head_height = max(hmx.y - hmn.y, 0.2)
        head_cam_loc = head_center + front * (head_height * 2.6) + right * (head_height * 0.06)
        cam.data.ortho_scale = head_height * 1.55
        cam.location = head_cam_loc
        head_forward = (head_center - head_cam_loc).normalized()
        hx = head_forward.cross(up_hint).normalized()
        hz = -head_forward
        hy = hz.cross(hx).normalized()
        cam.matrix_world = Matrix.Translation(head_cam_loc) @ Matrix((hx, hy, hz)).transposed().to_4x4()
        head_preview = os.path.splitext(args.preview)[0] + "_head.png"
        scene.render.filepath = head_preview
        bpy.ops.render.render(write_still=True)
        print(f"Head preview rendered to {head_preview}", flush=True)
    except Exception as exc:
        print(f"Preview render skipped: {exc}", flush=True)


def main():
    args = parse_args()
    for path in (args.body_rig, args.head_data, args.texture):
        if not os.path.exists(path):
            raise FileNotFoundError(path)
    ensure_dir(args.out_fbx)
    ensure_dir(args.out_blend)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.import_scene.fbx(filepath=args.body_rig)
    arm = find_armature()
    body = find_body(arm)
    bpy.context.view_layer.objects.active = body
    body.select_set(True)

    head_bone = arm.data.bones.get("head")
    neck_bone = arm.data.bones.get("neck")
    if head_bone is None or neck_bone is None:
        raise RuntimeError("The imported rig is missing its 'head' or 'neck' bone.")
    target_head = np.array(head_bone.head_local, dtype=np.float64)
    body_start, body_end, action = action_range(arm)
    fps = bpy.context.scene.render.fps
    print(f"Body rig: {len(body.data.vertices)} verts, frames {body_start}-{body_end} @ {fps}fps", flush=True)

    remove_count = delete_head_region(body, arm, args.delete_threshold)
    if remove_count >= len(body.data.vertices):
        raise RuntimeError("Body head removal left no body mesh.")
    if not args.keep_body_material or not body.data.materials:
        body.data.materials.clear()
        body.data.materials.append(make_material("GVHMR_Body_Skin", (0.12, 0.055, 0.035)))

    head_data = np.load(args.head_data)
    head, keys, face_count = build_head_mesh(args, head_data, target_head, arm, head_bone, neck_bone)
    animate_face(head, keys, body_start, body_end, args)

    # Copy the texture next to the deliverables and pack it into the .blend.
    texture_out = os.path.join(os.path.dirname(args.out_blend), "fused_face_texture.png")
    if os.path.abspath(texture_out) != os.path.abspath(args.texture):
        shutil.copy2(args.texture, texture_out)
    if head.data.materials and head.data.materials[0].use_nodes:
        for node in head.data.materials[0].node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image:
                node.image.filepath = texture_out
                node.image.reload()

    bpy.ops.file.pack_all()
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    body.select_set(True)
    head.select_set(True)
    bpy.context.view_layer.objects.active = arm

    bpy.ops.wm.save_as_mainfile(filepath=args.out_blend)
    print(f"Saved Blender scene: {args.out_blend}", flush=True)

    bpy.ops.export_scene.fbx(
        filepath=args.out_fbx,
        use_selection=True,
        object_types={"ARMATURE", "MESH"},
        add_leaf_bones=False,
        bake_anim=True,
        bake_anim_use_nla_strips=False,
        bake_anim_use_all_actions=False,
        bake_anim_force_startend_keying=True,
        mesh_smooth_type="FACE",
        path_mode="AUTO",
        embed_textures=True,
    )
    print(f"Exported fused FBX: {args.out_fbx} ({os.path.getsize(args.out_fbx)/1e6:.2f} MB)", flush=True)
    add_preview_render(args, arm, body, head)
    bpy.ops.wm.save_as_mainfile(filepath=args.out_blend)
    backup = args.out_blend + "1"
    if os.path.exists(backup):
        os.remove(backup)
    print(f"Updated Blender scene with preview camera: {args.out_blend}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
