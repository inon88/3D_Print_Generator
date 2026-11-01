/* [Dimensions] */
// Overall width
width = 56; // [30:1:100]
// Height of the bracket
height = 42; // [20:1:80]
// Material thickness
thickness = 6; // [3:0.5:12]
// Include mounting holes
mounting_holes = true;

difference() {
    cube([width, thickness, height]);
    if (mounting_holes) {
        for (z = [10, height - 10])
            translate([width / 2, -1, z])
                rotate([-90, 0, 0])
                    cylinder(h = thickness + 2, d = 5, $fn = 32);
    }
}
